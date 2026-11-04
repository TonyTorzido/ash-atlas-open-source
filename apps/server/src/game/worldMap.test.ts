import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { WorldMapService } from "./worldMap.js";

describe("WorldMapService strategic landmarks", () => {
  it("returns only the player's current city, kingdom, and built manor", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "city-1",
        name: "Ash City",
        hall_lat: 35,
        hall_lon: -106
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: "manor-1",
        world_lat: 36,
        world_lon: -105
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: "kingdom-1",
        display_name: "Ash Kingdom",
        seat_id: "seat-1",
        lat: 37,
        lon: -104
      }] });
    const service = new WorldMapService(
      { query } as unknown as pg.Pool,
      { WORLD_ID: "world-1" }
    );

    await expect(service.strategicLandmarks("player-1")).resolves.toEqual([
      { kind: "city", id: "city-1", name: "Ash City", lat: 35, lon: -106 },
      { kind: "manor", id: "manor-1", name: "Your Manor", lat: 36, lon: -105 },
      { kind: "kingdom", id: "kingdom-1", name: "Ash Kingdom", lat: 37, lon: -104 }
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toContain("atlas_shrine");
  });
});

describe("WorldMapService social player presentation", () => {
  it("includes the authoritative remote appearance payload and display color", async () => {
    const appearance: PlayerAppearanceSnapshot = {
      schemaVersion: 1,
      catalogRevision: 1,
      revision: 3,
      bodyVariantId: "default",
      poseId: "idle",
      slots: {},
      styles: {},
      activeHand: null
    };
    const query = vi.fn()
      // featured capital + largest-city lookups run before the snapshot queries
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        player_id: "remote-player",
        username: "Bex",
        display_color: "#c85a8b",
        lat: 35.12,
        lon: -106.65,
        published_at: "2026-09-11T00:00:00.000Z"
      }] })
      // private Map Marker rows, then the Pathfinder Boot mark lookup
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const socialPlayerState = vi.fn(() => ({ appearance }));
    const service = new WorldMapService(
      { query } as unknown as pg.Pool,
      { WORLD_ID: "world-1" },
      { socialPlayerState }
    );

    await expect(service.snapshot("viewer")).resolves.toMatchObject({
      socialVisibility: {
        friends: true,
        kingdom_members: true,
        city_members: true
      },
      socialPlayers: [{
        playerId: "remote-player",
        username: "Bex",
        displayColor: "#c85a8b",
        appearance
      }]
    });
    expect(socialPlayerState).toHaveBeenCalledWith("remote-player");
  });
});
