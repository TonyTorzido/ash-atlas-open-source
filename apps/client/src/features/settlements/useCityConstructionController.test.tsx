// @vitest-environment jsdom

import type {
  CityAppSnapshot,
  CityPhysicalConstructionAction,
  CityStructureSnapshot
} from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PendingCityBuildAction } from "./cityConstructionPresentation.js";
import {
  type CityConstructionCommands,
  useCityConstructionController
} from "./useCityConstructionController.js";

const cost = {
  materials: [{ itemId: "stone", quantity: 10 }],
  cityCoins: 20,
  cityGold: 0
};

const cityApp = {
  city: { id: "city-1", spatialRevision: "city-revision-4" },
  district: {
    districtRevision: "district-revision-7"
  },
  facilityCosts: {
    warehouse: { 1: cost, 2: cost, 3: cost },
    cistern_warrens: { 1: cost, 2: cost, 3: cost },
    salon: { 1: cost, 2: cost, 3: cost },
    city_kennel: { 1: cost, 2: cost, 3: cost }
  },
  civicCosts: {
    market: cost,
    monument: { 1: cost, 2: cost, 3: cost }
  }
} as unknown as CityAppSnapshot;

const warehouse = {
  structureId: "warehouse-1",
  cityId: "city-1",
  type: "warehouse",
  tier: 1,
  districtType: null,
  ownerPlayerId: null,
  worldId: "main",
  regionCode: "US-NM",
  lat: 35,
  lon: -106,
  footprintRadiusM: 10,
  placementRevision: "placement-3",
  state: "active",
  constructionStartedAt: null,
  constructionCompletesAt: null,
  builtAt: "2026-08-01T00:00:00.000Z",
  upgradedAt: null,
  destroyedAt: null
} as CityStructureSnapshot;

const monument = {
  ...warehouse,
  structureId: "monument-1",
  type: "monument",
  districtType: "mining"
} as CityStructureSnapshot;

function commands(overrides: Partial<CityConstructionCommands> = {}) {
  return {
    buildCityHouse: vi.fn(() => "house-request"),
    buildOilWell: vi.fn(() => "oil-request"),
    buildCityFacility: vi.fn(() => "facility-request"),
    upgradeCityFacility: vi.fn(() => "facility-upgrade-request"),
    buildCityMarket: vi.fn(() => "market-request"),
    buildCityMonument: vi.fn(() => "monument-request"),
    upgradeCityMonument: vi.fn(() => "monument-upgrade-request"),
    destroyCityHouse: vi.fn(() => true),
    destroyOilWell: vi.fn(() => true),
    destroyCityFacility: vi.fn(() => true),
    ...overrides
  } satisfies CityConstructionCommands;
}

function renderController(input: {
  commands?: CityConstructionCommands | null;
  snapshot?: CityAppSnapshot | null;
  busy?: boolean;
} = {}) {
  const client = input.commands === undefined ? commands() : input.commands;
  const trackRequest = vi.fn((requestId: string | null) => Boolean(requestId));
  const setBusy = vi.fn();
  const clearWarning = vi.fn();
  const showActionError = vi.fn();
  const hook = renderHook(() => useCityConstructionController({
    getCommands: () => client,
    cityApp: input.snapshot === undefined ? cityApp : input.snapshot,
    busy: input.busy ?? false,
    trackRequest,
    setBusy,
    clearWarning,
    showActionError
  }));
  return {
    ...hook,
    client,
    trackRequest,
    setBusy,
    clearWarning,
    showActionError
  };
}

describe("useCityConstructionController", () => {
  it.each<{
    action: PendingCityBuildAction;
    method: keyof CityConstructionCommands;
    args: readonly unknown[];
    tracked: CityPhysicalConstructionAction;
  }>([
    {
      action: { kind: "oil-well", cityId: "city-1" },
      method: "buildOilWell",
      args: ["city-1"],
      tracked: "build_oil_well"
    },
    {
      action: { kind: "warehouse", cityId: "city-1" },
      method: "buildCityFacility",
      args: ["city-1", "warehouse"],
      tracked: "build_facility"
    },
    {
      action: { kind: "cistern-warrens", cityId: "city-1" },
      method: "buildCityFacility",
      args: ["city-1", "cistern_warrens"],
      tracked: "build_facility"
    },
    {
      action: { kind: "salon", cityId: "city-1" },
      method: "buildCityFacility",
      args: ["city-1", "salon"],
      tracked: "build_facility"
    },
    {
      action: { kind: "city-kennel", cityId: "city-1" },
      method: "buildCityFacility",
      args: ["city-1", "city_kennel"],
      tracked: "build_facility"
    },
    {
      action: { kind: "warehouse-upgrade", structure: warehouse },
      method: "upgradeCityFacility",
      args: ["warehouse-1", 1],
      tracked: "upgrade_facility"
    },
    {
      action: { kind: "market", cityId: "city-1" },
      method: "buildCityMarket",
      args: ["city-1", "city-revision-4"],
      tracked: "build_market"
    },
    {
      action: { kind: "monument", cityId: "city-1", districtType: "mining" },
      method: "buildCityMonument",
      args: ["city-1", "mining", "city-revision-4", "district-revision-7"],
      tracked: "build_monument"
    },
    {
      action: { kind: "monument-upgrade", structure: monument },
      method: "upgradeCityMonument",
      args: ["monument-1", 1, "placement-3", "district-revision-7"],
      tracked: "upgrade_monument"
    }
  ])("dispatches $action.kind with the authoritative revisions", ({
    action,
    method,
    args,
    tracked
  }) => {
    const harness = renderController();
    act(() => harness.result.current.actions.requestBuild(action));
    expect(harness.result.current.view.buildPrompt).not.toBeNull();

    act(() => harness.result.current.actions.confirmBuild());

    expect(harness.client?.[method]).toHaveBeenCalledWith(...args);
    expect(harness.trackRequest).toHaveBeenCalledWith(expect.any(String), tracked);
    expect(harness.result.current.view.buildPrompt).toBeNull();
  });

  it("cancels without dispatching and preserves the existing confirmation wording", () => {
    const harness = renderController();
    act(() => harness.result.current.actions.requestBuild({
      kind: "oil-well",
      cityId: "city-1"
    }));
    expect(harness.result.current.view.buildPrompt?.message).toContain(
      "Moving away cancels construction and refunds the materials."
    );

    act(() => harness.result.current.actions.cancelBuild());

    expect(harness.client?.buildOilWell).not.toHaveBeenCalled();
    expect(harness.result.current.view.buildPrompt).toBeNull();
  });

  it("keeps a generic build confirmation open when current City records are stale", () => {
    const harness = renderController({ snapshot: null });
    act(() => harness.result.current.actions.requestBuild({
      kind: "market",
      cityId: "city-1"
    }));
    act(() => harness.result.current.actions.confirmBuild());

    expect(harness.trackRequest).toHaveBeenCalledWith(null, "build_market");
    expect(harness.showActionError).toHaveBeenCalledWith(
      "Cannot begin city construction while disconnected or using stale City records."
    );
    expect(harness.result.current.view.buildPrompt).not.toBeNull();
  });

  it("does not dispatch civic construction with a mismatched City App", () => {
    const harness = renderController({
      snapshot: {
        ...cityApp,
        city: { id: "city-2", spatialRevision: "city-revision-4" }
      } as unknown as CityAppSnapshot
    });
    act(() => harness.result.current.actions.requestBuild({
      kind: "market",
      cityId: "city-1"
    }));
    act(() => harness.result.current.actions.confirmBuild());

    expect(harness.client?.buildCityMarket).not.toHaveBeenCalled();
    expect(harness.trackRequest).toHaveBeenCalledWith(null, "build_market");
    expect(harness.showActionError).toHaveBeenCalledWith(
      "Cannot begin city construction while disconnected or using stale City records."
    );
    expect(harness.result.current.view.buildPrompt).not.toBeNull();
  });

  it("owns City House confirmation, dispatch, and disconnected cleanup", () => {
    const online = renderController();
    act(() => online.result.current.actions.requestHouseBuild());
    expect(online.result.current.view.housePrompt?.message).toContain(
      "City membership begins when authoritative construction completes."
    );
    act(() => online.result.current.actions.confirmHouseBuild());
    expect(online.client?.buildCityHouse).toHaveBeenCalledOnce();
    expect(online.trackRequest).toHaveBeenCalledWith("house-request", "build_house");
    expect(online.clearWarning).toHaveBeenCalledOnce();
    expect(online.result.current.view.housePrompt).toBeNull();

    const offline = renderController({ commands: null });
    act(() => offline.result.current.actions.requestHouseBuild());
    act(() => offline.result.current.actions.confirmHouseBuild());
    expect(offline.showActionError).toHaveBeenCalledWith(
      "Cannot build a City House while disconnected."
    );
    expect(offline.result.current.view.housePrompt).toBeNull();
  });

  it.each([
    ["house", "destroyCityHouse"],
    ["oil-well", "destroyOilWell"],
    ["facility", "destroyCityFacility"]
  ] as const)("dispatches %s destruction and closes only after send", (kind, method) => {
    const harness = renderController();
    act(() => harness.result.current.actions.requestDestruction({ kind, structure: warehouse }));
    act(() => harness.result.current.actions.confirmDestruction());

    expect(harness.client?.[method]).toHaveBeenCalledWith("warehouse-1", "placement-3");
    expect(harness.setBusy).toHaveBeenCalledWith(true);
    expect(harness.result.current.view.destructionPrompt).toBeNull();
  });

  it("keeps destruction available for retry when the command cannot be sent", () => {
    const harness = renderController({ commands: null });
    act(() => harness.result.current.actions.requestDestruction({
      kind: "facility",
      structure: warehouse
    }));
    act(() => harness.result.current.actions.confirmDestruction());

    expect(harness.showActionError).toHaveBeenCalledWith(
      "Cannot destroy a city building while disconnected."
    );
    expect(harness.setBusy).not.toHaveBeenCalled();
    expect(harness.result.current.view.destructionPrompt).not.toBeNull();
  });
});
