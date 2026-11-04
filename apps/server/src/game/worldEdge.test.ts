import type pg from "pg";
import {
  WORLD_EDGE_ERROR_CODE,
  WORLD_EDGE_MAX_ABS_LATITUDE,
  WORLD_EDGE_MESSAGE
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { worldEdgeTravelBlock } from "../realtime/travelRealtimeOperations.js";
import { FlagService } from "./flags.js";
import { GameState, type PlayerRecord } from "./state.js";

const HEMISPHERES = [
  { name: "north", sign: 1 },
  { name: "south", sign: -1 }
] as const;

function stateWithPlayer(anchor: { lat: number; lon: number }): { state: GameState; player: PlayerRecord } {
  const state = new GameState(loadConfig({ NODE_ENV: "test" }));
  const player = state.helloPlayer("edge-player", "Edge");
  state.teleportPlayer(player.playerId, anchor);
  return { state, player: state.getPlayer(player.playerId)! };
}

describe.each(HEMISPHERES)("world edge authority ($name)", ({ sign }) => {
  const edge = sign * WORLD_EDGE_MAX_ABS_LATITUDE;

  it("accepts movement inside the edge and rejects targets past it", () => {
    const { state, player } = stateWithPlayer({ lat: sign * 84.9, lon: 12 });
    expect(state.setTarget(player.playerId, { lat: sign * 84.902, lon: 12 }).target)
      .toEqual({ lat: sign * 84.902, lon: 12 });

    const nearEdge = stateWithPlayer({ lat: sign * 84.999, lon: 12 });
    for (const lat of [85.1, 89.9]) {
      expect(() => nearEdge.state.setTarget(nearEdge.player.playerId, { lat: sign * lat, lon: 12 }))
        .toThrow(WORLD_EDGE_MESSAGE);
    }
    expect(nearEdge.state.setTarget(nearEdge.player.playerId, { lat: edge, lon: 12 }).target)
      .toEqual({ lat: edge, lon: 12 });
  });

  it("rejects combat repositioning past the edge", () => {
    const { state, player } = stateWithPlayer({ lat: sign * 84.9995, lon: 12 });
    expect(state.repositionCombatPlayer(player.playerId, { lat: sign * 84.9999, lon: 12 })).toBe(true);
    expect(state.repositionCombatPlayer(player.playerId, { lat: sign * 85.0001, lon: 12 })).toBe(false);
  });

  it("clamps system relocations (teleport, arrival scatter, manor return) onto the edge", () => {
    for (const lat of [85.1, 89.9]) {
      const { state, player } = stateWithPlayer({ lat: sign * 84.9, lon: 12 });
      state.teleportPlayer(player.playerId, { lat: sign * lat, lon: 30 });
      expect(state.getPlayer(player.playerId)?.position).toEqual({ lat: edge, lon: 30 });
      expect(state.getPlayer(player.playerId)?.anchor).toEqual({ lat: edge, lon: 30 });

      state.applyAuthoritativeRelocation({
        playerId: player.playerId,
        anchor: { lat: sign * 84.9999, lon: 31 },
        playerSpawnPosition: { lat: sign * lat, lon: 31 },
        resourceVision: null
      });
      expect(state.getPlayer(player.playerId)?.position).toEqual({ lat: edge, lon: 31 });

      state.relocateToAnchor(player.playerId, { lat: sign * lat, lon: 32 });
      expect(state.getPlayer(player.playerId)?.position).toEqual({ lat: edge, lon: 32 });
      expect(state.getPlayer(player.playerId)?.anchor).toEqual({ lat: edge, lon: 32 });
    }
  });

  it("refuses a flag or area view anchored past the edge", () => {
    const { state, player } = stateWithPlayer({ lat: sign * 84.9, lon: 12 });
    const center = { lat: sign * 85.1, lon: 12 };
    expect(() => state.applyAuthoritativeRelocation({
      playerId: player.playerId,
      anchor: center,
      resourceVision: {
        flagId: null,
        flagName: null,
        regionCode: "test",
        center,
        radiusM: 650,
        movementLeashRadiusM: 600
      } as never
    })).toThrow(WORLD_EDGE_MESSAGE);
    expect(state.getPlayer(player.playerId)?.position.lat).toBeCloseTo(sign * 84.9, 9);
  });

  it("clamps a persisted legacy player past the edge on connect", () => {
    const { state, player } = stateWithPlayer({ lat: sign * 84.9, lon: 12 });
    state.markOffline(player.playerId);
    const connected = state.connectPlayer({
      ...player,
      position: { lat: sign * 89.9, lon: 12 },
      anchor: { lat: sign * 85.1, lon: 12 },
      resourceVision: null
    });
    expect(connected.position).toEqual({ lat: edge, lon: 12 });
    expect(connected.anchor).toEqual({ lat: edge, lon: 12 });
  });

  it("refuses travel to a destination past the edge", () => {
    const destination = (lat: number) => ({
      kind: "flag" as const,
      id: "flag-1",
      center: { lat, lon: 12 }
    });
    expect(worldEdgeTravelBlock({ destination: destination(sign * 84.9) })).toBeNull();
    expect(worldEdgeTravelBlock({ destination: destination(edge) })).toBeNull();
    for (const lat of [85.1, 89.9]) {
      expect(worldEdgeTravelBlock({ destination: destination(sign * lat) })).toEqual({
        code: WORLD_EDGE_ERROR_CODE,
        message: WORLD_EDGE_MESSAGE
      });
    }
  });

  it("rejects flag placement past the edge before any territory query", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "flag-2", owner_id: "other", owner_username: "Rival", name: "Rival" }],
      rowCount: 1
    }));
    const service = new FlagService(
      { query } as unknown as pg.Pool,
      {} as never,
      {} as never,
      { info: vi.fn(), warn: vi.fn() } as never,
      {} as never
    );
    const { player } = stateWithPlayer({ lat: sign * 84.9, lon: 12 });

    const inside = await service.tryCreatePlacementQuote(player);
    expect(inside.failure?.code).toBe("FLAG_PLACEMENT_REJECTED");
    expect(query).toHaveBeenCalledTimes(1);

    for (const lat of [85.1, 89.9]) {
      const beyond = await service.tryCreatePlacementQuote({
        ...player,
        position: { lat: sign * lat, lon: 12 }
      });
      expect(beyond.failure).toMatchObject({
        code: WORLD_EDGE_ERROR_CODE,
        message: WORLD_EDGE_MESSAGE
      });
    }
    expect(query).toHaveBeenCalledTimes(1);
  });
});
