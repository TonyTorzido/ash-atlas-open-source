import { describe, expect, it, vi } from "vitest";

import { PlayerLocationService } from "./playerLocationService.js";

describe("PlayerLocationService", () => {
  it("keeps player geometry synchronized when a portal commits to world coordinates", async () => {
    const current = {
      region_code: "world-old", lat: 35, lon: -106, location_kind: "interior",
      location_type: "manor", location_id: "home", location_instance_id: "manor:home",
      location_space_id: "manor_foyer", location_local_x: 500, location_local_y: 880,
      location_facing: null, location_revision: 9, last_portal_id: "entry",
      last_transition_request_id: null, last_transition_request_hash: null
    };
    const committed = {
      ...current, region_code: "world-new", lat: 36, lon: -107,
      location_kind: "world", location_type: null, location_id: null,
      location_instance_id: null, location_space_id: null,
      location_local_x: null, location_local_y: null, location_revision: 10,
      last_portal_id: "exit", last_transition_request_id: "request",
      last_transition_request_hash: "a".repeat(64)
    };
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FOR UPDATE")) return { rows: [current], rowCount: 1 };
      expect(sql).toContain("geom=CASE");
      expect(sql).toContain("ST_SetSRID(ST_MakePoint($12,$11),4326)");
      return { rows: [committed], rowCount: 1 };
    });
    const release = vi.fn();
    const service = new PlayerLocationService({
      connect: vi.fn(async () => ({ query, release }))
    } as never);

    await expect(service.commitPortalTransition({
      playerId: "player", requestId: "request", portalId: "exit",
      expectedRevision: 9,
      destination: {
        kind: "world", regionCode: "world-new", position: { lat: 36, lon: -107 }
      }
    })).resolves.toMatchObject({
      replayed: false,
      location: { kind: "world", position: { lat: 36, lon: -107 }, revision: 10 }
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("loads and replays legacy-stored sewer coordinates as canonical indoor units", async () => {
    const row = {
      region_code: "world", lat: 35, lon: -106, location_kind: "interior",
      location_type: "cistern_warrens", location_id: "sewer-1",
      location_instance_id: "sewer:sewer-1", location_space_id: "sewer_entrance",
      location_local_x: 14, location_local_y: 24, location_facing: null,
      location_revision: 3, last_portal_id: "entry",
      last_transition_request_id: "request", last_transition_request_hash: "hash"
    };
    const service = new PlayerLocationService({
      query: vi.fn(async () => ({ rows: [row], rowCount: 1 }))
    } as never);

    await expect(service.load("player")).resolves.toMatchObject({
      kind: "interior", position: { x: 87.5, y: 150 }
    });
    await expect(service.replayPortalTransition("player", "request", "hash"))
      .resolves.toMatchObject({ position: { x: 87.5, y: 150 } });
  });

  it("stores canonical sewer portal destinations in the legacy encoding", async () => {
    const current = {
      region_code: "world", lat: 35, lon: -106, location_kind: "world",
      location_type: null, location_id: null, location_instance_id: null,
      location_space_id: null, location_local_x: null, location_local_y: null,
      location_facing: null, location_revision: 7, last_portal_id: null,
      last_transition_request_id: null, last_transition_request_hash: null
    };
    const updated = {
      ...current, location_kind: "interior", location_type: "cistern_warrens",
      location_id: "sewer-1", location_instance_id: "sewer:sewer-1",
      location_space_id: "sewer_entrance", location_local_x: 140, location_local_y: 80,
      location_revision: 8, last_portal_id: "portal", last_transition_request_id: "request",
      last_transition_request_hash: "hash"
    };
    let updateValues: unknown[] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FOR UPDATE")) return { rows: [current], rowCount: 1 };
      if (sql.startsWith("UPDATE players")) {
        updateValues = values;
        return { rows: [updated], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = new PlayerLocationService({
      connect: vi.fn(async () => ({ query, release: vi.fn() }))
    } as never);

    await expect(service.commitPortalTransition({
      playerId: "player", requestId: "request", requestHash: "hash",
      portalId: "portal", expectedRevision: 7,
      destination: {
        kind: "interior", locationType: "cistern_warrens", locationId: "sewer-1",
        instanceId: "sewer:sewer-1", spaceId: "sewer_entrance",
        position: { x: 875, y: 500 }
      }
    })).resolves.toMatchObject({
      replayed: false, location: { position: { x: 875, y: 500 } }
    });
    expect(updateValues[6]).toBe(140);
    expect(updateValues[7]).toBe(80);
  });

  it("guards sewer-only position encoding without changing other interior inputs", async () => {
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      void sql;
      void values;
      return { rows: [], rowCount: 1 };
    });
    const service = new PlayerLocationService({ query } as never);
    await service.persistInteriorPosition({
      playerId: "player", instanceId: "sewer:1", spaceId: "sewer_depths",
      x: 625, y: 312.5
    });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("THEN $4::double precision/$7::double precision ELSE $4 END");
    expect(values).toEqual(["player", "sewer:1", "sewer_depths", 625, 312.5, null, 6.25]);

    query.mockClear();
    await service.persistInteriorPosition({
      playerId: "player", instanceId: "manor:1", spaceId: "manor_main_room",
      x: 625, y: 312.5
    });
    expect(query.mock.calls[0]![1]).toEqual([
      "player", "manor:1", "manor_main_room", 625, 312.5, null, 6.25
    ]);
  });
});
