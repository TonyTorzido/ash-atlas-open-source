import { describe, expect, it, vi } from "vitest";

import {
  MILITARY_TRAVEL_WARNING,
  MilitaryIndustryService
} from "./militaryIndustry.js";

type QueryResult = { rows: unknown[]; rowCount: number };

function serviceFor(
  groups: Array<{
    group_id: string;
    location_state: "FOLLOWING_PLAYER" | "DEPLOYED_FIELD";
    lat: number | null;
    lon: number | null;
  }>,
  compatibleCity = false,
  compatibleCamp = false
) {
  const query = vi.fn(async (
    sql: string,
    _params?: readonly unknown[]
  ): Promise<QueryResult> => {
    void _params;
    if (sql.includes("FROM military_unit_groups")) {
      return { rows: groups, rowCount: groups.length };
    }
    if (sql.includes("FROM cities city")) {
      return { rows: compatibleCity ? [{}] : [], rowCount: compatibleCity ? 1 : 0 };
    }
    if (sql.includes("FROM war_camps")) {
      return { rows: compatibleCamp ? [{}] : [], rowCount: compatibleCamp ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = {
    query,
    release: vi.fn()
  };
  const pool = {
    connect: vi.fn(async () => client)
  };
  const service = new MilitaryIndustryService(
    pool as never,
    "world-1",
    {} as never
  );
  return { service, query, client };
}

const baseInput = {
  playerId: "player-1",
  operationKind: "flag" as const,
  destinationKind: "flag" as const,
  destinationId: "flag-1",
  destinationCenter: { lat: 40.5, lon: -105.5 },
  lastKnownPosition: { lat: 35.25, lon: -106.6 }
};

describe("MilitaryIndustryService travel reconciliation", () => {
  it("leaves following and field groups behind for GPS without a Hunger path", async () => {
    const { service, query, client } = serviceFor([
      {
        group_id: "group-1",
        location_state: "FOLLOWING_PLAYER",
        lat: 35.25,
        lon: -106.6
      },
      {
        group_id: "group-2",
        location_state: "DEPLOYED_FIELD",
        lat: 35.3,
        lon: -106.65
      }
    ]);

    const result = await service.preserveMilitaryOnTravel({
      ...baseInput,
      operationKind: "gps_relocate",
      destinationKind: "world",
      destinationId: null
    });

    expect(result).toEqual({
      accompaniedGroups: 0,
      leftBehindGroups: 2,
      warning: MILITARY_TRAVEL_WARNING
    });
    expect(query.mock.calls.some(([sql]) => /hunger|food/i.test(sql))).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql.includes("UPDATE military_")).length).toBe(6);
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM cities")).length).toBe(0);
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM war_camps")).length).toBe(0);
    expect(query.mock.calls.some(([sql]) => sql.includes("location_state='FOLLOWING_PLAYER' THEN 'DEPLOYED_FIELD'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("COALESCE(lat,$2),lon=COALESCE(lon,$3)"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("moves field-following groups only to the owner's eligible City anchor", async () => {
    const { service, query } = serviceFor([
      {
        group_id: "group-1",
        location_state: "FOLLOWING_PLAYER",
        lat: 35.25,
        lon: -106.6
      },
      {
        group_id: "group-2",
        location_state: "DEPLOYED_FIELD",
        lat: 35.3,
        lon: -106.65
      }
    ], true);

    const result = await service.preserveMilitaryOnTravel({
      ...baseInput,
      operationKind: "city",
      destinationKind: "city",
      destinationId: "00000000-0000-4000-8000-000000000001"
    });

    expect(result).toEqual({ accompaniedGroups: 2, leftBehindGroups: 0, warning: null });
    const destinationUpdates = query.mock.calls.filter(([sql, params]) =>
      sql.includes("UPDATE military_") &&
      Array.isArray(params) && params[1] === 40.5 && params[2] === -105.5
    );
    expect(destinationUpdates).toHaveLength(4);
    expect(query.mock.calls.some(([sql]) => sql.includes("location_state='FOLLOWING_PLAYER' THEN 'DEPLOYED_FIELD'"))).toBe(false);
  });

  it("uses an exact owned War Camp anchor for non-GPS travel and remains replay-safe", async () => {
    const { service, query } = serviceFor([
      {
        group_id: "group-1",
        location_state: "FOLLOWING_PLAYER",
        lat: 35.25,
        lon: -106.6
      }
    ], false, true);

    const input = {
      ...baseInput,
      operationKind: "party_manual" as const,
      destinationKind: "world" as const,
      destinationId: null,
      destinationCenter: { lat: 40.5, lon: -105.5 }
    };
    await service.preserveMilitaryOnTravel(input);
    await service.preserveMilitaryOnTravel(input);

    expect(query.mock.calls.filter(([sql]) => sql.includes("IS DISTINCT FROM")).length).toBe(4);
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM war_camps")).length).toBe(2);
  });
});
