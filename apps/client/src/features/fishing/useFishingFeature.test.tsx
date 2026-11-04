// @vitest-environment jsdom

import type {
  FishingBiteEvent,
  FishingEncounterSnapshot,
  FishingHutWorldSnapshot,
  FishingStateSnapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManorClient as Client } from "../../client/domains/manorClient.js";
import { useFishingFeature } from "./useFishingFeature.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useFishingFeature encounter ownership", () => {
  it("keeps hut selection stable while encounter state changes", () => {
    const target = hut();
    const hookOptions = options({
      openFishingHut: vi.fn(() => "open-1")
    });
    const hook = renderHook(() => useFishingFeature(hookOptions));
    const initialSelect = hook.result.current.actions.select;

    act(() => hook.result.current.actions.select(target));
    expect(hook.result.current.actions.select).toBe(initialSelect);

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      requestId: "open-1",
      state: state(null)
    }));
    expect(hook.result.current.actions.select).toBe(initialSelect);

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STATE",
      state: state(encounter("cast", null))
    }));
    expect(hook.result.current.actions.select).toBe(initialSelect);
  });

  it("ignores delayed pre-cast snapshots and keeps the accepted cast presentation", () => {
    const openFishingHut = vi.fn()
      .mockReturnValueOnce("open-1")
      .mockReturnValueOnce("open-2");
    const startFishing = vi.fn(() => "start-1");
    const fishingCast = vi.fn(() => "cast-1");
    const target = hut();
    const castPoint = { lat: 35.0005, lon: -106.0005 };
    const hook = renderHook(() => useFishingFeature(options({ openFishingHut, startFishing, fishingCast })));

    act(() => hook.result.current.actions.select(target));
    act(() => hook.result.current.actions.handleServerMessage({ type: "FISHING_STATE", requestId: "open-1", state: state(null) }));
    act(() => hook.result.current.actions.start());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STARTED",
      requestId: "start-1",
      state: state(encounter("cast", null, 1_000, 3_000)),
      replayed: false
    }));

    // This is the same refresh that can be left in flight when a player taps
    // a square. Its response represents the state before the cast was saved.
    void act(() => hook.result.current.actions.refresh(target.fishingHutId, "app"));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      requestId: "open-2",
      state: state(encounter("cast", null, 1_050, 3_000))
    }));
    act(() => hook.result.current.actions.cast(castPoint));
    expect(fishingCast).toHaveBeenCalledWith(
      expect.any(String),
      0.5,
      castPoint
    );
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CAST_RESULT",
      requestId: "cast-1",
      state: state(encounter("cast", castPoint, 1_200, 3_000)),
      replayed: false
    }));
    expect(hook.result.current.view.targeting).toBe(false);
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound" });

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      requestId: "open-2",
      state: state(encounter("cast", null, 1_000, 3_000))
    }));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STATE",
      state: state(encounter("cast", null, 1_050, 3_000))
    }));
    expect(hook.result.current.view.targeting).toBe(false);
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound" });

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STATE",
      state: state(encounter("bite", castPoint, 3_000, 3_000, { kind: "true_strike", startedAt: 3_000, endsAt: 3_500 }))
    }));
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound", cue: "true_strike" });
  });

  it("does not poll before a square is accepted, then refreshes the active cast", () => {
    vi.useFakeTimers();
    const openFishingHut = vi.fn()
      .mockReturnValueOnce("open-1")
      .mockReturnValueOnce("open-2");
    const startFishing = vi.fn(() => "start-1");
    const fishingCast = vi.fn(() => "cast-1");
    const target = hut();
    const castPoint = { lat: 35.0005, lon: -106.0005 };
    const hook = renderHook(() => useFishingFeature(options({ openFishingHut, startFishing, fishingCast })));

    act(() => hook.result.current.actions.select(target));
    act(() => hook.result.current.actions.handleServerMessage({ type: "FISHING_STATE", requestId: "open-1", state: state(null) }));
    act(() => hook.result.current.actions.start());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STARTED",
      requestId: "start-1",
      state: state(encounter("cast", null, 1_000, 1_500)),
      replayed: false
    }));
    void act(() => vi.advanceTimersByTime(2_000));
    expect(openFishingHut).toHaveBeenCalledOnce();

    act(() => hook.result.current.actions.cast(castPoint));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CAST_RESULT",
      requestId: "cast-1",
      state: state(encounter("cast", castPoint, 1_000, 1_500)),
      replayed: false
    }));
    void act(() => vi.advanceTimersByTime(600));
    expect(openFishingHut).toHaveBeenCalledTimes(2);
  });

  it("keeps an active encounter as the only hut action and resets it for a fresh start", () => {
    const openFishingHut = vi.fn(() => "open-1");
    const startFishing = vi.fn(() => "start-1");
    const fishingCancel = vi.fn(() => "cancel-1");
    const target = hut();
    const encounterState = state(encounter("cast", null));
    const hook = renderHook(() => useFishingFeature(options({ openFishingHut, startFishing, fishingCancel })));

    act(() => hook.result.current.actions.select(target));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      requestId: "open-1",
      state: state(null)
    }));
    expect(hook.result.current.view.actionOpen).toBe(true);

    act(() => hook.result.current.actions.start());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STARTED",
      requestId: "start-1",
      state: encounterState,
      replayed: false
    }));
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.targeting).toBe(true);

    act(() => hook.result.current.actions.select(target));
    expect(openFishingHut).toHaveBeenCalledOnce();
    expect(hook.result.current.view.actionOpen).toBe(false);
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.targeting).toBe(true);

    act(() => hook.result.current.actions.cancel());
    expect(fishingCancel).toHaveBeenCalledWith(encounterState.encounter?.encounterId);
    expect(hook.result.current.view.state).toBeNull();
    expect(hook.result.current.view.encounterOutcome).toBeNull();
    expect(hook.result.current.view.pending.cancel).toBe("cancel-1");

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "cancel-1",
      state: { ...encounterState, encounter: { ...encounterState.encounter!, phase: "cancelled" } },
      replayed: false
    }));
    expect(hook.result.current.view.state).toBeNull();
    expect(hook.result.current.view.pending.cancel).toBeNull();

    act(() => hook.result.current.actions.select(target));
    expect(openFishingHut).toHaveBeenCalledTimes(2);
    expect(hook.result.current.view.actionOpen).toBe(true);
  });

  it("refreshes the server-owned bite cue and keeps a missed hook in Float Set", () => {
    vi.useFakeTimers();
    let openRequest = 0;
    const openFishingHut = vi.fn(() => `open-${++openRequest}`);
    const startFishing = vi.fn(() => "start-1");
    const fishingCast = vi.fn(() => "cast-1");
    const fishingCancel = vi.fn(() => "cancel-1");
    const target = hut();
    const hook = renderHook(() => useFishingFeature(options({ openFishingHut, startFishing, fishingCast, fishingCancel })));

    act(() => hook.result.current.actions.select(target));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      requestId: "open-1",
      state: state(null)
    }));
    act(() => hook.result.current.actions.start());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STARTED",
      requestId: "start-1",
      state: state(encounter("cast", null)),
      replayed: false
    }));

    const castPoint = { lat: 35.0005, lon: -106.0005 };
    act(() => hook.result.current.actions.cast(castPoint));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CAST_RESULT",
      requestId: "cast-1",
      state: state(encounter("cast", castPoint, 1_000, 1_500)),
      replayed: false
    }));
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.targeting).toBe(false);
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound" });

    void act(() => vi.advanceTimersByTime(600));
    expect(openFishingHut).toHaveBeenCalledTimes(2);
    expect(hook.result.current.view.pending.open).toBe("open-2");

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      requestId: "open-2",
      state: state(encounter("bite", castPoint, 1_500, 1_500, {
        kind: "true_strike",
        startedAt: 1_800,
        endsAt: 3_000
      }))
    }));
    expect(hook.result.current.view.encounterOutcome).toBeNull();
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound", cue: "true_strike" });

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_STATE",
      state: state(encounter("cast", castPoint, 3_000, 4_500))
    }));
    expect(hook.result.current.view.encounterOutcome).toBeNull();
    expect(hook.result.current.view.actionOpen).toBe(false);
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.feedback).toContain("float is set again");

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STATE",
      state: state(encounter("fighting", castPoint, 4_000, 4_500))
    }));
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound" });
    act(() => hook.result.current.actions.control("right", true));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "control-1",
      state: state(encounter("fighting", castPoint, 4_250, 4_500)),
      replayed: false
    }));
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound" });

    act(() => hook.result.current.actions.control("left", false));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "control-1",
      state: state({
        ...encounter("escaped", castPoint, 4_500, 4_500),
        tension: 100,
        criticalMs: 2_000
      }),
      replayed: false
    }));
    expect(hook.result.current.view.castPresentation).toMatchObject({ point: castPoint, status: "bound" });
    expect(hook.result.current.view.feedback).toContain("Fish escaped");

    act(() => hook.result.current.actions.cancel());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "cancel-1",
      state: { ...state(encounter("bite", castPoint, 3_000, 1_500)), encounter: { ...encounter("bite", castPoint, 3_000, 1_500), phase: "cancelled" } },
      replayed: false
    }));
    act(() => hook.result.current.actions.select(target));
    expect(hook.result.current.view.encounterOutcome).toBeNull();
    expect(hook.result.current.view.actionOpen).toBe(true);
  });

  it("queues a phone release behind an in-flight authoritative control", () => {
    let controlRequest = 0;
    const fishingControl = vi.fn(() => `control-${++controlRequest}`);
    const hook = renderHook(() => useFishingFeature(options({ fishingControl })));
    const fightingState = state(encounter("fighting", null));

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STATE",
      state: fightingState
    }));
    act(() => hook.result.current.actions.control("left", true));
    act(() => hook.result.current.actions.control("neutral", false));
    expect(fishingControl).toHaveBeenCalledOnce();
    expect(fishingControl).toHaveBeenLastCalledWith(
      fightingState.encounter!.encounterId,
      "left",
      true
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "control-1",
      state: fightingState,
      replayed: false
    }));
    expect(fishingControl).toHaveBeenCalledTimes(2);
    expect(fishingControl).toHaveBeenLastCalledWith(
      fightingState.encounter!.encounterId,
      "neutral",
      false
    );
  });

  it("serializes a sustained phone hold and release without a request storm", () => {
    let controlRequest = 0;
    const fishingControl = vi.fn(() => `control-${++controlRequest}`);
    const hook = renderHook(() => useFishingFeature(options({ fishingControl })));
    const fightingState = state(encounter("fighting", null));

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_ENCOUNTER_STATE",
      state: fightingState
    }));

    // The prompt's bounded cadence may report several identical hold intents
    // before a mobile round trip completes. Only one request is in flight;
    // the latest intent is retained for the next authoritative interval.
    act(() => {
      hook.result.current.actions.control("right", true);
      hook.result.current.actions.control("right", true);
      hook.result.current.actions.control("right", true);
    });
    expect(fishingControl).toHaveBeenCalledOnce();
    expect(fishingControl).toHaveBeenLastCalledWith(
      fightingState.encounter!.encounterId,
      "right",
      true
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "control-1",
      state: fightingState,
      replayed: false
    }));
    expect(fishingControl).toHaveBeenCalledTimes(2);
    expect(fishingControl).toHaveBeenLastCalledWith(
      fightingState.encounter!.encounterId,
      "right",
      true
    );

    act(() => {
      hook.result.current.actions.control("right", true);
      hook.result.current.actions.control("neutral", false);
    });
    expect(fishingControl).toHaveBeenCalledTimes(2);

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "control-2",
      state: fightingState,
      replayed: false
    }));
    expect(fishingControl).toHaveBeenCalledTimes(3);
    expect(fishingControl).toHaveBeenLastCalledWith(
      fightingState.encounter!.encounterId,
      "neutral",
      false
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FISHING_CONTROL_RESULT",
      requestId: "control-3",
      state: fightingState,
      replayed: false
    }));
    expect(fishingControl).toHaveBeenCalledTimes(3);
  });
});

function options(methods: Readonly<{
  openFishingHut?: () => string | null;
  startFishing?: () => string | null;
  fishingCast?: () => string | null;
  fishingControl?: () => string | null;
  fishingCancel?: () => string | null;
}> = {}) {
  const commands = {
    openFishingHut: methods.openFishingHut ?? vi.fn(() => "open-1"),
    startFishing: methods.startFishing ?? vi.fn(() => "start-1"),
    fishingCast: methods.fishingCast ?? vi.fn(() => "cast-1"),
    fishingControl: methods.fishingControl ?? vi.fn(() => "control-1"),
    fishingCancel: methods.fishingCancel ?? vi.fn(() => "cancel-1")
  } as unknown as Client;
  return {
    connectionStatus: "online" as const,
    localPlayer: player(35, -106),
    getCommands: () => commands,
    requestMove: vi.fn(() => true),
    receiveInventory: vi.fn(),
    receiveDroppedItems: vi.fn(),
    showActionError: vi.fn()
  };
}

function hut(): FishingHutWorldSnapshot {
  return {
    fishingHutId: "00000000-0000-4000-8000-000000000001",
    ownerPlayerId: "player-1",
    ownerUsername: "Ash",
    worldId: "world-test",
    regionCode: "world-test",
    lat: 35,
    lon: -106,
    builtAt: "2026-01-01T00:00:00.000Z",
    placementRevision: 1,
    waterbody: {
      kind: "river",
      sourceId: "rio-grande",
      displayName: "Rio Grande",
      distanceM: 0
    },
    passiveStoredQuantity: 0,
    passiveCapacity: 16,
    passiveReadyQuantity: 0
  };
}

function player(lat: number, lon: number): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: null,
    regionCode: "world-test",
    zoneId: "world-test:zone",
    lat,
    lon,
    anchorLat: lat,
    anchorLon: lon,
    moveLeashRadiusM: 10_000,
    movementRevision: 1,
    relocationRevision: 1,
    targetLat: null,
    targetLon: null,
    moving: false,
    currentFlagId: null,
    online: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function encounter(
  phase: FishingEncounterSnapshot["phase"],
  castPoint: FishingEncounterSnapshot["castPoint"],
  serverTime = 1_000,
  biteAt = 1_500,
  biteEvent: FishingBiteEvent | null = null
): FishingEncounterSnapshot {
  return {
    encounterId: "fishing-encounter-1",
    fishingHutId: hut().fishingHutId,
    phase,
    waterbody: hut().waterbody,
    castPoint,
    behaviorProfile: "runner",
    difficulty: 0.5,
    ashen: false,
    castQuality: 0.8,
    biteAt,
    biteEvent,
    serverTime,
    tension: 35,
    distance: 60,
    stamina: 75,
    slackMs: 0,
    criticalMs: 0,
    fishDirection: "left",
    fishPull: 1.25,
    executionQuality: 0.8,
    catch: null,
    reconnectDeadlineAt: 60_000
  };
}

function state(activeEncounter: FishingEncounterSnapshot | null): FishingStateSnapshot {
  return {
    hut: hut(),
    encounter: activeEncounter,
    personalBestWeightLb: null,
    personalBestScore: null,
    weeklyBestFiveScore: 0,
    serverTime: activeEncounter?.serverTime ?? 1_000
  };
}
