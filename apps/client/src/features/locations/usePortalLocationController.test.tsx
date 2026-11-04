// @vitest-environment jsdom
import type {
  PlayerLocationSnapshot,
  PortalServerMessage,
  WorldViewAuthority
} from "@ash-atlas/shared";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GameClient } from "../../gameClient.js";
import { LocationSceneHost } from "./LocationSceneHost.js";
import { usePortalLocationController } from "./usePortalLocationController.js";

afterEach(cleanup);

const world: PlayerLocationSnapshot = {
  kind: "world", regionCode: "NM", zoneId: "world:NM",
  position: { lat: 35, lon: -106 }, revision: 1
};
const foyer: PlayerLocationSnapshot = {
  kind: "interior", locationType: "manor", locationId: "home",
  instanceId: "manor:home", spaceId: "manor_foyer",
  regionCode: "interior:manor:home", zoneId: "interior:manor:home:manor_foyer",
  position: { x: 500, y: 840 }, revision: 2, lastPortalId: "entry"
};

function plan(): PortalServerMessage {
  return {
    type: "PORTAL_TRANSITION_PLANNED", requestId: "request-1", transitionId: "transition-1",
    portalId: "manor:home:world-to-foyer", portalRevision: "1",
    source: { kind: "world", regionCode: "NM", position: { lat: 35, lon: -106 } },
    destination: {
      kind: "interior", locationType: "manor", locationId: "home",
      instanceId: "manor:home", spaceId: "manor_foyer", position: { x: 500, y: 880 }
    },
    sourceApproach: { lat: 35.0001, lon: -106 },
    sourceThreshold: { lat: 35.00005, lon: -106 },
    preloadSceneKey: "manor/manor_foyer", presentation: "door", status: "Enter Manor"
  };
}

describe("usePortalLocationController", () => {
  it("forwards the canonical reconnect location to presentation readiness", () => {
    const client = createRef<GameClient | null>();
    const onLocation = vi.fn();
    const { result } = renderHook(() =>
      usePortalLocationController(client, vi.fn(), onLocation)
    );

    act(() => result.current.handleServerMessage({
      type: "PLAYER_LOCATION_SNAPSHOT",
      location: foyer
    }));

    expect(result.current.location).toEqual(foyer);
    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation).toHaveBeenCalledWith(foyer);
  });

  it("preloads during approach but keeps the source scene until canonical commit", async () => {
    const portalDestinationReady = vi.fn();
    const client = createRef<GameClient | null>();
    client.current = { portalDestinationReady } as unknown as GameClient;
    const { result } = renderHook(() => usePortalLocationController(client, vi.fn()));

    act(() => result.current.handleServerMessage({ type: "PLAYER_LOCATION_SNAPSHOT", location: world }));
    await act(async () => result.current.handleServerMessage(plan()));

    expect(result.current.phase).toBe("approaching");
    expect(result.current.location).toEqual(world);
    expect(portalDestinationReady).toHaveBeenCalledWith("transition-1", "manor/manor_foyer");

    act(() => result.current.handleServerMessage({
      type: "PORTAL_TRANSITION_PHASE", transitionId: "transition-1",
      phase: "waiting_for_destination"
    }));
    expect(result.current.phase).toBe("threshold_reached");
    expect(result.current.location).toEqual(world);
  });

  it("keeps the authoritative source after a precommit failure", () => {
    const client = createRef<GameClient | null>();
    const onError = vi.fn();
    const { result } = renderHook(() => usePortalLocationController(client, onError));
    act(() => result.current.handleServerMessage({ type: "PLAYER_LOCATION_SNAPSHOT", location: world }));
    act(() => result.current.handleServerMessage({
      type: "PORTAL_TRANSITION_FAILED", requestId: "request-1", transitionId: "transition-1",
      code: "ACCESS_DENIED", message: "Locked", location: world
    }));
    expect(result.current.location).toEqual(world);
    expect(result.current.phase).toBe("failed");
    expect(onError).toHaveBeenCalledWith("Locked");
  });

  it("keeps the cover until the committed Manor scene mounts", async () => {
    vi.useFakeTimers();
    try {
      const client = createRef<GameClient | null>();
      const { result } = renderHook(() => usePortalLocationController(client, vi.fn()));

      act(() => result.current.handleServerMessage(plan()));
      act(() => result.current.handleServerMessage({
        type: "PLAYER_LOCATION_SNAPSHOT",
        location: foyer,
        transitionId: "transition-1"
      }));

      expect(result.current.phase).toBe("committed");
      act(() => result.current.destinationSceneMounted("manor/manor_foyer"));
      expect(result.current.phase).toBe("committed");

      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(result.current.phase).toBe("revealing");
      await act(async () => { await vi.advanceTimersByTimeAsync(180); });
      expect(result.current.phase).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cover until the exact world presentation callback arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = createRef<GameClient | null>();
      const { result } = renderHook(() => usePortalLocationController(client, vi.fn()));

      act(() => result.current.handleServerMessage(plan()));
      act(() => result.current.handleServerMessage({
        type: "PLAYER_LOCATION_SNAPSHOT",
        location: world,
        transitionId: "transition-1"
      }));

      expect(result.current.phase).toBe("committed");
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(result.current.phase).toBe("committed");

      act(() => result.current.destinationPresentationReady());
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(result.current.phase).toBe("revealing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an already-ready world presentation at the canonical commit", async () => {
    vi.useFakeTimers();
    try {
      const client = createRef<GameClient | null>();
      const { result } = renderHook(() => usePortalLocationController(
        client,
        vi.fn(),
        undefined,
        { isWorldPresentationReady: () => true }
      ));

      act(() => result.current.handleServerMessage(plan()));
      act(() => result.current.handleServerMessage({
        type: "PLAYER_LOCATION_SNAPSHOT",
        location: world,
        transitionId: "transition-1"
      }));

      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(result.current.phase).toBe("revealing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stale world presentation authority before revealing", async () => {
    vi.useFakeTimers();
    try {
      const authority: WorldViewAuthority = {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 2,
        relocationRevision: 3,
        resourceVisionRevision: 4,
        gameplayViewGeneration: 5,
        populationPreparationGeneration: 6
      };
      const client = createRef<GameClient | null>();
      const { result } = renderHook(() => usePortalLocationController(
        client,
        vi.fn(),
        undefined,
        {
          isWorldPresentationAuthorityCurrent: (candidate) =>
            candidate.relocationRevision === authority.relocationRevision
        }
      ));
      act(() => result.current.handleServerMessage(plan()));
      act(() => result.current.handleServerMessage({
        type: "PLAYER_LOCATION_SNAPSHOT",
        location: world,
        transitionId: "transition-1"
      }));
      act(() => result.current.destinationPresentationReady({
        ...authority,
        relocationRevision: authority.relocationRevision - 1
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(result.current.phase).toBe("committed");
      act(() => result.current.destinationPresentationReady(authority));
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(result.current.phase).toBe("revealing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns quietly to idle after an intentional cancellation", () => {
    const client = createRef<GameClient | null>();
    const onError = vi.fn();
    const { result } = renderHook(() => usePortalLocationController(client, onError));
    act(() => result.current.handleServerMessage(plan()));
    act(() => result.current.handleServerMessage({
      type: "PORTAL_TRANSITION_FAILED", requestId: "request-1", transitionId: "transition-1",
      code: "CANCELLED", message: "Portal transition cancelled.", location: world
    }));
    expect(result.current.location).toEqual(world);
    expect(result.current.phase).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("LocationSceneHost", () => {
  it("selects a space scene from the canonical location", () => {
    const onSceneMounted = vi.fn();
    render(<LocationSceneHost location={foyer} scenes={{
      world: <span>World</span>,
      "manor/manor_foyer": <span>Foyer</span>
    }} onSceneMounted={onSceneMounted} />);
    expect(screen.getByText("Foyer")).toBeTruthy();
    expect(screen.queryByText("World")).toBeNull();
    expect(onSceneMounted).toHaveBeenCalledWith("manor/manor_foyer");
  });

  it("renders every validated cistern warrens space through the shared dungeon scene", () => {
    render(<LocationSceneHost location={{
      ...foyer,
      locationType: "cistern_warrens",
      locationId: "sewer-1",
      instanceId: "sewer:sewer-1",
      spaceId: "workshop_chamber"
    }} scenes={{
      world: <span>World</span>,
      "cistern_warrens/*": <span>Dungeon</span>
    }} />);
    expect(screen.getByText("Dungeon")).toBeTruthy();
    expect(screen.queryByText("World")).toBeNull();
  });

  it("renders every authored dungeon space through the shared dungeon scene", () => {
    render(<LocationSceneHost location={{
      ...foyer,
      locationType: "dungeon",
      locationId: "orc-cave",
      instanceId: "dungeon:orc-cave",
      spaceId: "boss_chamber"
    }} scenes={{
      world: <span>World</span>,
      "dungeon/*": <span>Authored Dungeon</span>
    }} />);
    expect(screen.getByText("Authored Dungeon")).toBeTruthy();
    expect(screen.queryByText("World")).toBeNull();
  });
});
