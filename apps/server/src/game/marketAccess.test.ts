import type pg from "pg";
import { CITY_MARKET_INTERACTION_RADIUS_M } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { MarketAccessPolicy } from "./marketAccess.js";

const actor = {
  playerId: "market-access-player",
  accountId: "00000000-0000-4000-8000-000000000711"
};

describe("MarketAccessPolicy", () => {
  it("rejects missing, stale, and cross-connection sessions without fallback", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const access = new MarketAccessPolicy(
      loadConfig({ NODE_ENV: "test", MARKET_GLOBAL_ACCESS: "true" }),
      {
        getPlayer: vi.fn(() => ({
          online: true,
          relocationRevision: 0,
          position: { lat: 35, lon: -106 }
        })),
        isWorldPresent: vi.fn(() => true)
      } as never
    );

    await expect(access.requireSession(
      { query } as unknown as pg.Pool,
      actor,
      "wrong-connection",
      "00000000-0000-4000-8000-000000000712"
    )).rejects.toMatchObject({
      code: "MARKET_ACCESS_DENIED",
      retryable: false
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("invalidates a session when player relocation authority changes", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          session_id: "00000000-0000-4000-8000-000000000712",
          connection_id: "connection-one",
          relocation_revision: "3",
          venue_id: "00000000-0000-4000-8000-000000000713",
          venue_key: "city-market",
          display_name: "City Market",
          city_id: "00000000-0000-4000-8000-000000000714",
          city_name: "City",
          market_structure_id: "00000000-0000-4000-8000-000000000715",
          lat: 35,
          lon: -106,
          active_monument_types: ["forestry", "mining"],
          tax_revision: "1"
        }]
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const access = new MarketAccessPolicy(
      loadConfig({ NODE_ENV: "test" }),
      {
        getPlayer: vi.fn(() => ({
          online: true,
          relocationRevision: 4,
          position: { lat: 35, lon: -106 }
        })),
        isWorldPresent: vi.fn(() => true)
      } as never
    );

    await expect(access.requireSession(
      { query } as unknown as pg.Pool,
      actor,
      "connection-one",
      "00000000-0000-4000-8000-000000000712"
    )).rejects.toMatchObject({ code: "MARKET_ACCESS_DENIED" });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("invalidated_reason = 'authority_changed'"),
      ["00000000-0000-4000-8000-000000000712"]
    );
  });

  it("returns every active Monument type with a valid session", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        session_id: "00000000-0000-4000-8000-000000000712",
        connection_id: "connection-one",
        relocation_revision: "0",
        venue_id: "00000000-0000-4000-8000-000000000713",
        venue_key: "city-market",
        display_name: "City Market",
        city_id: "00000000-0000-4000-8000-000000000714",
        city_name: "City",
        market_structure_id: "00000000-0000-4000-8000-000000000715",
        lat: 35,
        lon: -106,
        active_monument_types: ["forestry", "hunting", "mining"],
        tax_revision: "7",
        placement_revision: "4"
      }]
    }));
    const access = new MarketAccessPolicy(loadConfig({ NODE_ENV: "test" }), {
      getPlayer: vi.fn(() => ({
        online: true,
        relocationRevision: 0,
        position: { lat: 35, lon: -106 }
      })),
      isWorldPresent: vi.fn(() => true)
    } as never);

    await expect(access.requireSession(
      { query } as unknown as pg.Pool,
      actor,
      "connection-one",
      "00000000-0000-4000-8000-000000000712"
    )).resolves.toMatchObject({
      activeMonumentTypes: ["forestry", "hunting", "mining"],
      taxRevision: "7"
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("monument.district_type IN ('mining', 'forestry', 'hunting')"),
      ["00000000-0000-4000-8000-000000000712", actor.playerId, "connection-one"]
    );
  });

  it("rejects a fresh Market session beyond the 50 meter boundary", async () => {
    const query = vi.fn(async () => ({ rows: [marketAuthorityRow()] }));
    const access = accessAtMeters(CITY_MARKET_INTERACTION_RADIUS_M + 1);

    await expect(access.openSession(
      { query } as unknown as pg.Pool,
      actor,
      "connection-one",
      "00000000-0000-4000-8000-000000000715",
      "4"
    )).rejects.toMatchObject({
      code: "MARKET_ACCESS_DENIED",
      message: `Move within ${CITY_MARKET_INTERACTION_RADIUS_M} meters of the City Market.`,
      diagnostics: {
        interactionRadiusM: CITY_MARKET_INTERACTION_RADIUS_M,
        invalidationReason: "outside_interaction_radius"
      }
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("invalidates existing Market session authority beyond the 50 meter boundary", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        ...marketAuthorityRow(),
        session_id: "00000000-0000-4000-8000-000000000712",
        connection_id: "connection-one",
        relocation_revision: "0"
      }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const access = accessAtMeters(CITY_MARKET_INTERACTION_RADIUS_M + 1);

    await expect(access.requireSession(
      { query } as unknown as pg.Pool,
      actor,
      "connection-one",
      "00000000-0000-4000-8000-000000000712"
    )).rejects.toMatchObject({
      code: "MARKET_ACCESS_DENIED",
      diagnostics: {
        interactionRadiusM: CITY_MARKET_INTERACTION_RADIUS_M,
        invalidationReason: "authority_changed"
      }
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("invalidated_reason = 'authority_changed'"),
      ["00000000-0000-4000-8000-000000000712"]
    );
  });
});

function accessAtMeters(distanceM: number): MarketAccessPolicy {
  return new MarketAccessPolicy(loadConfig({ NODE_ENV: "test" }), {
    getPlayer: vi.fn(() => ({
      online: true,
      relocationRevision: 0,
      position: { lat: 35 + distanceM / 111_195, lon: -106 }
    })),
    isWorldPresent: vi.fn(() => true)
  } as never);
}

function marketAuthorityRow() {
  return {
    venue_id: "00000000-0000-4000-8000-000000000713",
    venue_key: "city-market",
    display_name: "City Market",
    city_id: "00000000-0000-4000-8000-000000000714",
    city_name: "City",
    market_structure_id: "00000000-0000-4000-8000-000000000715",
    lat: 35,
    lon: -106,
    active_monument_types: [],
    tax_revision: "1",
    placement_revision: "4"
  };
}
