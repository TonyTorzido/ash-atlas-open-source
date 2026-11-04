import type { PlayerSnapshot } from "@ash-atlas/shared";
import { WORLD_EDGE_MESSAGE, distanceMeters, moveToward } from "@ash-atlas/shared";
import { expect, it, vi } from "vitest";

import { PlayerRenderTimeline } from "./playerRenderSmoothing.js";
import {
  OUTSIDE_MOVEMENT_RANGE_WARNING,
  runIfLocalMovementTargetIsValid
} from "./localMovementValidation.js";

it("does not send, track, or anticipate a destination outside the local movement leash", () => {
  const player = playerSnapshot();
  const destination = moveToward(
    { lat: player.anchorLat, lon: player.anchorLon },
    { lat: player.anchorLat, lon: player.anchorLon + 0.02 },
    player.moveLeashRadiusM + 1
  );
  const timeline = new PlayerRenderTimeline();
  timeline.configureLocalPlayer(player.playerId, { speedMps: 500, serverTickHz: 20 });
  timeline.applySnapshot([player], 1_000, 1_000, { sequence: 0 });
  const before = timeline.renderPosition(player.playerId, 1_000)!;
  const send = vi.fn(() => "move-1");
  const track = vi.fn();
  const anticipate = vi.fn();
  const warn = vi.fn();

  const result = runIfLocalMovementTargetIsValid(
    player,
    destination,
    warn,
    () => {
      const requestId = send();
      track(requestId);
      anticipate(requestId);
      timeline.beginLocalAnticipation(requestId, 1, destination, 1_000);
      return requestId;
    }
  );

  expect(result).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(track).not.toHaveBeenCalled();
  expect(anticipate).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(OUTSIDE_MOVEMENT_RANGE_WARNING);
  expect(timeline.renderPosition(player.playerId, 1_016)).toEqual(before);
});

it("allows a finite destination inside the local movement leash", () => {
  const player = playerSnapshot();
  const destination = moveToward(
    { lat: player.anchorLat, lon: player.anchorLon },
    { lat: player.anchorLat, lon: player.anchorLon + 0.02 },
    player.moveLeashRadiusM - 1
  );
  const warn = vi.fn();
  const request = vi.fn(() => "move-1");

  expect(runIfLocalMovementTargetIsValid(player, destination, warn, request)).toBe("move-1");
  expect(request).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});

it("keeps valid anticipated movement active when a later invalid destination is ignored", () => {
  const player = playerSnapshot();
  const validDestination = moveToward(player, { lat: player.lat, lon: player.lon + 0.02 }, 500);
  const invalidDestination = moveToward(
    { lat: player.anchorLat, lon: player.anchorLon },
    { lat: player.anchorLat, lon: player.anchorLon + 0.02 },
    player.moveLeashRadiusM + 100
  );
  const timeline = new PlayerRenderTimeline();
  timeline.configureLocalPlayer(player.playerId, { speedMps: 500, serverTickHz: 20 });
  timeline.applySnapshot([player], 1_000, 1_000, { sequence: 0 });
  timeline.renderPosition(player.playerId, 1_000);
  timeline.beginLocalAnticipation("move-1", 1, validDestination, 1_000);
  const beforeInvalid = timeline.renderPosition(player.playerId, 1_016)!;
  const invalidRequest = vi.fn(() => "move-2");

  runIfLocalMovementTargetIsValid(player, invalidDestination, vi.fn(), invalidRequest);
  const afterInvalid = timeline.renderPosition(player.playerId, 1_032)!;

  expect(invalidRequest).not.toHaveBeenCalled();
  expect(distanceMeters(beforeInvalid, afterInvalid)).toBeGreaterThan(0);
  expect(distanceMeters(player, afterInvalid)).toBeGreaterThan(distanceMeters(player, beforeInvalid));
});

it("allows only finite WGS84 destinations to bypass the old leash while request-bound", () => {
  const player = playerSnapshot();
  const destination = { lat: 40.7608, lon: -111.8910 };
  const request = vi.fn(() => "move-after-travel");
  const warn = vi.fn();

  expect(runIfLocalMovementTargetIsValid(
    player,
    destination,
    warn,
    request,
    "travel-request"
  )).toBe("move-after-travel");
  expect(request).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
  expect(runIfLocalMovementTargetIsValid(
    player,
    { lat: 91, lon: 0 },
    warn,
    request,
    "travel-request"
  )).toBeNull();
});

function playerSnapshot(): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Avery",
    displayColor: "#38bdf8",
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35.0844,
    lon: -106.6504,
    anchorLat: 35.0844,
    anchorLon: -106.6504,
    moveLeashRadiusM: 900,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
}

it.each([1, -1])("does not send a move past the world edge (hemisphere %i)", (sign) => {
  const player = {
    ...playerSnapshot(),
    lat: sign * 84.999,
    anchorLat: sign * 84.999,
    anchorLon: 0,
    lon: 0
  };
  for (const lat of [85.1, 89.9]) {
    const warn = vi.fn();
    const request = vi.fn(() => "move-1");
    expect(runIfLocalMovementTargetIsValid(player, { lat: sign * lat, lon: 0 }, warn, request)).toBeNull();
    expect(runIfLocalMovementTargetIsValid(
      player,
      { lat: sign * lat, lon: 0 },
      warn,
      request,
      "travel-request"
    )).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(WORLD_EDGE_MESSAGE);
  }
  const request = vi.fn(() => "move-2");
  expect(runIfLocalMovementTargetIsValid(player, { lat: sign * 84.9995, lon: 0 }, vi.fn(), request))
    .toBe("move-2");
});
