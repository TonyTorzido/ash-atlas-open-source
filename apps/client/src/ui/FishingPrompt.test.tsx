// @vitest-environment jsdom

import {
  FISHING_CONTROL_UPDATE_INTERVAL_MS,
  type FishingEncounterSnapshot,
  type FishingHutWorldSnapshot,
  type FishingStateSnapshot
} from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FishingActionPrompt,
  FishingPrompt,
  FishingTargetingPrompt,
  fishingPercentileLabel
} from "./FishingPrompt.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FishingActionPrompt", () => {
  it("keeps Fish as an explicit Hut action before entering cast targeting", () => {
    const onStart = vi.fn();
    const onFish = vi.fn();
    render(<FishingActionPrompt
      hut={hut()}
      state={state(null)}
      connected
      feedback={null}
      busy={false}
      onFish={onFish}
      onStart={onStart}
      onCollect={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Fish" }));
    expect(onStart).toHaveBeenCalledOnce();
    expect(onFish).not.toHaveBeenCalled();
  });
});

describe("FishingPrompt", () => {
  it("keeps the active fight inside the canonical compact prompt with desktop and mobile controls", () => {
    const onControl = vi.fn();
    const onClose = vi.fn();
    const view = render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={onControl}
      onLand={vi.fn()}
      onClose={onClose}
    />);

    expect(view.container.querySelector(".fishing-overworld-prompt .game-compact-prompt")).toBeTruthy();
    expect(view.container.querySelector(".destination-shell-scrim")).toBeNull();
    expect(screen.getByRole("button", { name: "LEFT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "REEL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "RIGHT" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "a" });
    expect(onControl).toHaveBeenCalledWith("left", false);
    fireEvent.keyUp(window, { key: "a" });
    expect(onControl).toHaveBeenLastCalledWith("neutral", false);
    fireEvent.keyDown(window, { code: "Space" });
    expect(onControl).toHaveBeenLastCalledWith("neutral", true);
    fireEvent.keyUp(window, { code: "Space" });
    expect(onControl).toHaveBeenLastCalledWith("neutral", false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns a missed hook to Float Set without terminating the encounter", () => {
    const view = render(<FishingPrompt
      state={state(encounter("cast"))}
      feedback="The strike passed. The float is set again; watch for another bite."
      busy={false}
      onHook={vi.fn()}
      onControl={vi.fn()}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(view.container.querySelector('[data-fishing-phase="cast"]')).toBeTruthy();
    expect(view.container.querySelector(".game-compact-prompt")).toBeTruthy();
    expect(screen.getByText("Float set")).toBeTruthy();
    expect(screen.getByText("The strike passed. The float is set again; watch for another bite.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set hook" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Records" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to world" })).toBeNull();
  });

  it("keeps Set hook available for every visible bite cue without spoiling a fake", () => {
    for (const kind of ["nibble", "fake_nibble", "true_strike"] as const) {
      const onHook = vi.fn();
      const view = render(<FishingPrompt
        state={state({
          ...encounter("bite"),
          biteEvent: { kind, startedAt: 1_000, endsAt: 2_000 }
        })}
        feedback={null}
        busy={false}
        onHook={onHook}
        onControl={vi.fn()}
        onLand={vi.fn()}
        onClose={vi.fn()}
      />);

      expect(screen.getByRole("button", { name: "Set hook" })).toBeTruthy();
      expect(screen.queryByText("False nibble")).toBeNull();
      if (kind === "fake_nibble") expect(screen.getByText("Float movement")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Set hook" }));
      expect(onHook).toHaveBeenCalledOnce();
      view.unmount();
    }
  });

  it("shows the river scene, visual landing markers, and land readiness", () => {
    const onLand = vi.fn();
    const view = render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={vi.fn()}
      onLand={onLand}
      onClose={vi.fn()}
    />);

    expect(screen.getByText("River: Rio Grande")).toBeTruthy();
    const scene = view.container.querySelector(".fishing-encounter-scene");
    expect(scene).toBeTruthy();
    expect(scene?.getAttribute("data-pull-direction")).toBe("left");
    expect(scene?.getAttribute("aria-label")).toMatch(/counter with right/i);
    expect(view.container.querySelector(".fishing-encounter-scene-background")).toBeTruthy();
    expect(view.container.querySelector(".fishing-meter-landing-band")).toBeTruthy();
    expect(view.container.querySelector(".fishing-meter-threshold-distance")).toBeTruthy();
    expect(view.container.querySelector(".fishing-meter-threshold-stamina")).toBeTruthy();
    expect(view.container.querySelectorAll(".fishing-meter-landing-band > span, .fishing-meter-threshold > span")).toHaveLength(0);
    expect(view.container.querySelector(".fishing-pull-indicator")).toBeNull();
    expect(view.container.querySelector(".fishing-control-help")).toBeNull();
    expect(screen.queryByRole("button", { name: "Land fish" })).toBeNull();
    expect(screen.queryByText("Land fish when the green markers align.")).toBeNull();
    expect(screen.getByText("Landable when line tension is between 25% and 91%.")).toBeTruthy();
    expect(screen.getByText("Landable when fish distance is 12% or lower.")).toBeTruthy();
    expect(screen.getByText("Landable when fish stamina is 17% or lower.")).toBeTruthy();
    expect(screen.getByLabelText("Line tension").getAttribute("aria-describedby")).toBe("line-tension-threshold");

    view.rerender(<FishingPrompt
      state={state({ ...encounter("fighting"), distance: 10, stamina: 20, tension: 45 })}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={vi.fn()}
      onLand={onLand}
      onClose={vi.fn()}
    />);
    const land = screen.getByRole("button", { name: "Land fish" });
    expect(land).toHaveProperty("disabled", false);
    expect(screen.getByText("Ready to land")).toBeTruthy();
    fireEvent.click(land);
    expect(onLand).toHaveBeenCalledOnce();
  });

  it("releases held touch controls on pointer cancellation and window blur", () => {
    const onControl = vi.fn();
    render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={onControl}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    const left = screen.getByRole("button", { name: "LEFT" });
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { left.dispatchEvent(contextMenu); });
    expect(contextMenu.defaultPrevented).toBe(true);
    fireEvent.pointerDown(left, { pointerId: 1 });
    expect(left.getAttribute("aria-pressed")).toBe("true");
    expect(onControl).toHaveBeenLastCalledWith("left", false);
    fireEvent.pointerCancel(left, { pointerId: 1 });
    expect(left.getAttribute("aria-pressed")).toBe("false");
    expect(onControl).toHaveBeenLastCalledWith("neutral", false);

    const reel = screen.getByRole("button", { name: "REEL" });
    fireEvent.pointerDown(reel, { pointerId: 2 });
    expect(onControl).toHaveBeenLastCalledWith("neutral", true);
    fireEvent.blur(window);
    expect(onControl).toHaveBeenLastCalledWith("neutral", false);
  });

  it("keeps a held phone control on a bounded cadence and sends release", () => {
    vi.useFakeTimers();
    const onControl = vi.fn();
    render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={onControl}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    const left = screen.getByRole("button", { name: "LEFT" });
    fireEvent.pointerDown(left, { pointerId: 3 });
    vi.advanceTimersByTime(FISHING_CONTROL_UPDATE_INTERVAL_MS);
    expect(onControl).toHaveBeenCalledWith("left", false);
    fireEvent.pointerUp(left, { pointerId: 3 });
    expect(onControl).toHaveBeenLastCalledWith("neutral", false);
  });

  it("keeps steering and reel latched together across a sustained touch hold", () => {
    vi.useFakeTimers();
    const onControl = vi.fn();
    render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={onControl}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    const left = screen.getByRole("button", { name: "LEFT" });
    const reel = screen.getByRole("button", { name: "REEL" });
    fireEvent.pointerDown(left, { pointerId: 11 });
    void act(() => vi.advanceTimersByTime(FISHING_CONTROL_UPDATE_INTERVAL_MS * 3));
    expect(onControl.mock.calls.filter(([direction, reeling]) => direction === "left" && reeling === false)).toHaveLength(4);

    fireEvent.pointerDown(reel, { pointerId: 12 });
    expect(onControl).toHaveBeenLastCalledWith("left", true);
    void act(() => vi.advanceTimersByTime(FISHING_CONTROL_UPDATE_INTERVAL_MS * 2));
    expect(onControl.mock.calls.filter(([direction, reeling]) => direction === "left" && reeling === true)).toHaveLength(3);

    fireEvent.pointerUp(reel, { pointerId: 12 });
    expect(onControl).toHaveBeenLastCalledWith("left", false);
    void act(() => vi.advanceTimersByTime(FISHING_CONTROL_UPDATE_INTERVAL_MS));
    expect(onControl).toHaveBeenLastCalledWith("left", false);

    fireEvent.pointerUp(left, { pointerId: 11 });
    expect(onControl).toHaveBeenLastCalledWith("neutral", false);
    const callCountAfterRelease = onControl.mock.calls.length;
    void act(() => vi.advanceTimersByTime(FISHING_CONTROL_UPDATE_INTERVAL_MS * 2));
    expect(onControl).toHaveBeenCalledTimes(callCountAfterRelease);
  });

  it("does not send a late release after a terminal snapshot removes controls", () => {
    const onControl = vi.fn();
    const view = render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={onControl}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "LEFT" }), { pointerId: 13 });
    expect(onControl).toHaveBeenCalledOnce();

    view.rerender(<FishingPrompt
      state={state(encounter("escaped"))}
      feedback="Fish escaped — The line went slack too long."
      busy={false}
      onHook={vi.fn()}
      onControl={onControl}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(onControl).toHaveBeenCalledOnce();
  });

  it("keeps the prompt and action rows mounted while fight values update", () => {
    const view = render(<FishingPrompt
      state={state(encounter("fighting"))}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={vi.fn()}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    const prompt = view.container.querySelector(".game-compact-prompt");
    const actions = view.container.querySelector(".game-compact-actions");
    const actionCount = actions?.children.length;
    expect(view.container.querySelector(".fishing-encounter-scene")).toBeTruthy();
    expect(view.container.querySelector('[role="status"]')).toBeTruthy();

    view.rerender(<FishingPrompt
      state={state({ ...encounter("fighting"), tension: 82, distance: 48, stamina: 60, fishDirection: "right" })}
      feedback={null}
      busy={false}
      onHook={vi.fn()}
      onControl={vi.fn()}
      onLand={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(view.container.querySelector(".game-compact-prompt")).toBe(prompt);
    expect(view.container.querySelector(".game-compact-actions")?.children.length).toBe(actionCount);
  });

  it("keeps the escaped result legible until dismissal", () => {
    const onClose = vi.fn();
    const view = render(<FishingPrompt
      state={state({ ...encounter("escaped"), tension: 100, criticalMs: 2_000 })}
      feedback="Fish escaped — Line tension stayed too high."
      busy={false}
      onHook={vi.fn()}
      onControl={vi.fn()}
      onLand={vi.fn()}
      onClose={onClose}
    />);

    expect(screen.getByText("Fish escaped")).toBeTruthy();
    expect(screen.getByText("Fish escaped — Line tension stayed too high.")).toBeTruthy();
    expect(view.container.querySelector('[data-fishing-phase="escaped"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to world" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("FishingTargetingPrompt", () => {
  it("presents map targeting as a cancellable compact prompt", () => {
    const onCancel = vi.fn();
    const view = render(<FishingTargetingPrompt
      state={state(encounter("cast"))}
      feedback="Choose a square of freshwater on the map."
      busy={false}
      invalid={false}
      onCancel={onCancel}
    />);

    expect(view.container.querySelector(".fishing-targeting-placement > .game-action-prompt")).toBeTruthy();
    expect(view.container.querySelector(".fishing-targeting-help")).toBeTruthy();
    expect(view.container.querySelector(".destination-shell-scrim")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("Fishing record presentation", () => {
  it.each([
    [1, "1st percentile"],
    [2, "2nd percentile"],
    [3, "3rd percentile"],
    [11, "11th percentile"],
    [12, "12th percentile"],
    [13, "13th percentile"],
    [62, "62nd percentile"]
  ])("renders %s with the correct ordinal", (percentage, expected) => {
    expect(fishingPercentileLabel(percentage / 100)).toBe(expected);
  });
});

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

function encounter(phase: FishingEncounterSnapshot["phase"]): FishingEncounterSnapshot {
  return {
    encounterId: "fishing-encounter-1",
    fishingHutId: hut().fishingHutId,
    phase,
    waterbody: hut().waterbody,
    castPoint: { lat: 35.0005, lon: -106.0005 },
    behaviorProfile: "runner",
    difficulty: 0.5,
    ashen: false,
    castQuality: 0.8,
    biteAt: 1_500,
    biteEvent: null,
    serverTime: 1_000,
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
    serverTime: 1_000
  };
}
