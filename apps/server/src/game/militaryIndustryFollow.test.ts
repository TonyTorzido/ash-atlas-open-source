import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLAYER_SPEED_MPS,
  destinationPoint,
  distanceMeters,
  MILITARY_FOLLOW_DISTANCE_M,
  MILITARY_FOLLOW_FORMATION_SPACING_M,
  MILITARY_FOLLOW_SPEED_RATIO
} from "@ash-atlas/shared";
import { MilitaryIndustryService } from "./militaryIndustry.js";

type QueryResult = { rows: unknown[]; rowCount: number };

type FollowingGroupFixture = {
  group_id: string;
  owner_player_id: string;
  lat: number | null;
  lon: number | null;
  location_state?: string;
  unit_type?: string;
  movement_order?: "NONE" | "FOLLOW_PLAYER" | "MOVE_TO_COORDINATE";
  movement_target_lat?: number | null;
  movement_target_lon?: number | null;
};

function serviceForFollowingGroups(groups: readonly FollowingGroupFixture[]) {
  const normalizedGroups = groups.map((group) => {
    const locationState = group.location_state ?? "FOLLOWING_PLAYER";
    return {
      ...group,
      location_state: locationState,
      unit_type: group.unit_type ?? "field_ballista",
      movement_order: group.movement_order ?? (locationState === "FOLLOWING_PLAYER" ? "FOLLOW_PLAYER" : "NONE"),
      movement_target_lat: group.movement_target_lat ?? null,
      movement_target_lon: group.movement_target_lon ?? null
    };
  });
  const query = vi.fn(async (sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
    if (sql.includes("FROM military_unit_groups") && sql.includes("FOR UPDATE SKIP LOCKED")) {
      const locked = normalizedGroups.filter((group) => group.group_id === String(params?.[0]));
      return { rows: locked, rowCount: locked.length };
    }
    if (sql.includes("FROM military_unit_groups") && sql.includes("ORDER BY owner_player_id")) {
      return { rows: normalizedGroups, rowCount: normalizedGroups.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  const service = new MilitaryIndustryService(
    pool as never,
    "world-1",
    {} as never,
    undefined,
    undefined,
    DEFAULT_PLAYER_SPEED_MPS
  );
  return { service, query, client };
}

function serviceForFollowingGroup(group: FollowingGroupFixture) {
  return serviceForFollowingGroups([group]);
}

describe("MilitaryIndustryService Siege following tick", () => {
  it("moves at 70% of player speed toward the trailing 125m point without overshooting", async () => {
    const ownerPosition = { lat: 35, lon: -106 };
    const currentPosition = destinationPoint(ownerPosition, 250, 180);
    const ownerTarget = destinationPoint(ownerPosition, 1_000, 0);
    const { service, query } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: currentPosition.lat,
      lon: currentPosition.lon
    });

    await expect(service.reconcileFollowingMilitaryGroups([{
      playerId: "player-1",
      position: ownerPosition,
      target: ownerTarget,
      online: true,
      worldPresent: true
    }], 1)).resolves.toBe(1);

    const groupUpdate = query.mock.calls.find(([sql]) => sql.includes("UPDATE military_unit_groups"));
    const params = groupUpdate?.[1] as readonly unknown[];
    const nextPosition = { lat: Number(params[1]), lon: Number(params[2]) };
    expect(distanceMeters(currentPosition, nextPosition)).toBeCloseTo(
      DEFAULT_PLAYER_SPEED_MPS * MILITARY_FOLLOW_SPEED_RATIO,
      3
    );
    expect(distanceMeters(ownerPosition, nextPosition)).toBeGreaterThan(MILITARY_FOLLOW_DISTANCE_M);
  });

  it("keeps the current formation side when the owner is stationary", async () => {
    const ownerPosition = { lat: 35, lon: -106 };
    const currentPosition = destinationPoint(ownerPosition, 200, 180);
    const expectedPosition = destinationPoint(ownerPosition, MILITARY_FOLLOW_DISTANCE_M, 180);
    const { service, query } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: currentPosition.lat,
      lon: currentPosition.lon
    });

    await expect(service.reconcileFollowingMilitaryGroups([{
      playerId: "player-1",
      position: ownerPosition,
      target: null,
      online: true,
      worldPresent: true
    }], 10)).resolves.toBe(1);
    const groupUpdate = query.mock.calls.find(([sql]) => sql.includes("UPDATE military_unit_groups"));
    const params = groupUpdate?.[1] as readonly unknown[];
    expect(distanceMeters(expectedPosition, {
      lat: Number(params[1]),
      lon: Number(params[2])
    })).toBeLessThan(0.01);
  });

  it("stops a followed Siege safely when its owner is unavailable", async () => {
    const { service, query } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: 35,
      lon: -106
    });

    await expect(service.reconcileFollowingMilitaryGroups([], 1)).resolves.toBe(1);
    const updates = query.mock.calls
      .filter(([sql]) => sql.includes("UPDATE military_"))
      .map(([sql]) => sql);
    expect(updates).toHaveLength(2);
    expect(updates.every((sql) => sql.includes("location_state='DEPLOYED_FIELD'"))).toBe(true);
  });

  it("keeps the durable Follow order while the owner is briefly offline", async () => {
    const { service, query } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: 35,
      lon: -106
    });

    await expect(service.reconcileFollowingMilitaryGroups([{
      playerId: "player-1",
      position: { lat: 35, lon: -106 },
      target: null,
      online: false,
      worldPresent: true
    }], 1)).resolves.toBe(0);
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE military_"))).toBe(false);
  });

  it("rejects an invalid tick before acquiring a database connection", async () => {
    const { service, client } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: 35,
      lon: -106
    });

    await expect(service.reconcileFollowingMilitaryGroups([], -1)).rejects.toMatchObject({
      code: "MILITARY_INVALID_TICK"
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("advances a queued coordinate order at the canonical 70% speed without teleporting", async () => {
    const currentPosition = { lat: 35, lon: -106 };
    const target = destinationPoint(currentPosition, 300, 90);
    const { service, query } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: currentPosition.lat,
      lon: currentPosition.lon,
      location_state: "PACKED_FIELD",
      movement_order: "MOVE_TO_COORDINATE",
      movement_target_lat: target.lat,
      movement_target_lon: target.lon
    });

    await expect(service.reconcileFollowingMilitaryGroups([], 1)).resolves.toBe(1);
    const groupUpdate = query.mock.calls.find(([sql]) => sql.includes("UPDATE military_unit_groups"));
    const params = groupUpdate?.[1] as readonly unknown[];
    const nextPosition = { lat: Number(params[1]), lon: Number(params[2]) };
    expect(distanceMeters(currentPosition, nextPosition)).toBeCloseTo(
      DEFAULT_PLAYER_SPEED_MPS * MILITARY_FOLLOW_SPEED_RATIO,
      3
    );
    expect(distanceMeters(nextPosition, target)).toBeGreaterThan(0);
    expect(params[4]).toBe("MOVE_TO_COORDINATE");
  });

  it("clamps the final coordinate-order tick exactly and settles packed Stay", async () => {
    const currentPosition = { lat: 35, lon: -106 };
    const target = destinationPoint(currentPosition, 25, 90);
    const { service, query } = serviceForFollowingGroup({
      group_id: "group-1",
      owner_player_id: "player-1",
      lat: currentPosition.lat,
      lon: currentPosition.lon,
      location_state: "PACKED_FIELD",
      movement_order: "MOVE_TO_COORDINATE",
      movement_target_lat: target.lat,
      movement_target_lon: target.lon
    });

    await expect(service.reconcileFollowingMilitaryGroups([], 1)).resolves.toBe(1);
    const groupUpdate = query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE military_unit_groups") && sql.includes("SET location_state=$5"));
    const params = groupUpdate?.[1] as readonly unknown[];
    expect(Number(params[1])).toBe(target.lat);
    expect(Number(params[2])).toBe(target.lon);
    expect(distanceMeters({ lat: Number(params[1]), lon: Number(params[2]) }, target)).toBe(0);
  });

  it("assigns stable 50m lateral slots for mixed groups without stacking", async () => {
    const ownerPosition = { lat: 35, lon: -106 };
    const ownerTarget = destinationPoint(ownerPosition, 1_000, 0);
    const initialPosition = destinationPoint(ownerPosition, 300, 180);
    const groups = [
      { group_id: "group-a", owner_player_id: "player-1", lat: initialPosition.lat, lon: initialPosition.lon, unit_type: "field_ballista" },
      { group_id: "group-b", owner_player_id: "player-1", lat: initialPosition.lat, lon: initialPosition.lon, unit_type: "bomber" },
      { group_id: "group-c", owner_player_id: "player-1", lat: initialPosition.lat, lon: initialPosition.lon, unit_type: "infantry" }
    ];
    const { service, query } = serviceForFollowingGroups(groups);

    await expect(service.reconcileFollowingMilitaryGroups([{
      playerId: "player-1",
      position: ownerPosition,
      target: ownerTarget,
      online: true,
      worldPresent: true
    }], 100)).resolves.toBe(3);

    const positions = new Map(
      query.mock.calls
        .filter(([sql]) => sql.includes("UPDATE military_unit_groups") && sql.includes("SET lat=$2"))
        .map(([, params]) => [
          String((params as readonly unknown[])[3]),
          { lat: Number((params as readonly unknown[])[1]), lon: Number((params as readonly unknown[])[2]) }
        ])
    );
    const sorted = [...positions.entries()].sort(([left], [right]) => left.localeCompare(right));
    expect(sorted).toHaveLength(3);
    expect(distanceMeters(ownerPosition, sorted[0]![1])).toBeCloseTo(MILITARY_FOLLOW_DISTANCE_M, 0);
    expect(distanceMeters(sorted[0]![1], sorted[1]![1])).toBeGreaterThanOrEqual(MILITARY_FOLLOW_FORMATION_SPACING_M - 1);
    expect(distanceMeters(sorted[1]![1], sorted[2]![1])).toBeGreaterThanOrEqual(MILITARY_FOLLOW_FORMATION_SPACING_M - 1);
  });
});
