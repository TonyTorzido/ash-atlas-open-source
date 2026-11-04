import { describe, expect, it, vi } from "vitest";

// The PNG Lab catalog loads lazily in the app; registering it here mirrors an opened Lab.
import "./devPngCatalog.js";

import {
  consumeDevPngMapClick,
  DevPngLabController
} from "./devPngLabController.js";
import { RUNTIME_PNG_PRESENTATION_CATALOG } from "@ash-atlas/shared";
import { worldPngMasterScale } from "../map/worldPngMasterScale.js";

describe("local PNG Lab controller", () => {
  it("defaults to 1.00× and clamps next-placement sizing", () => {
    const controller = new DevPngLabController();
    expect(controller.getSnapshot().nextMultiplier).toBe(1);
    expect(controller.setNextMultiplier(99)).toBe(5);
    expect(controller.setNextMultiplier(-10)).toBe(0.01);
    expect(controller.setNextMultiplier(0.01)).toBe(0.01);
    expect(controller.setNextMultiplier(Number.NaN)).toBe(1);
  });

  it("keeps master-scale preview local and resets to the official catalog value", () => {
    const fetchSpy = vi.fn();
    const sendSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", class { send = sendSpy; });
    const controller = new DevPngLabController();

    expect(controller.getSnapshot().masterScale)
      .toBe(RUNTIME_PNG_PRESENTATION_CATALOG.masterScale);
    expect(controller.setMasterScale(2.345)).toBe(2.35);
    expect(worldPngMasterScale()).toBe(2.35);
    controller.resetMasterScale();
    expect(controller.getSnapshot().masterScale)
      .toBe(RUNTIME_PNG_PRESENTATION_CATALOG.masterScale);
    expect(worldPngMasterScale()).toBe(RUNTIME_PNG_PRESENTATION_CATALOG.masterScale);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("consumes placement-mode clicks without invoking any network operation", () => {
    const fetchSpy = vi.fn();
    const sendSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", class { send = sendSpy; });
    const controller = new DevPngLabController();
    expect(controller.startPlacement()).toBe(true);
    expect(consumeDevPngMapClick(controller, -106.6, 35.1)).toBe(true);
    expect(controller.getSnapshot().placements[0]).toMatchObject({
      longitude: -106.6,
      latitude: 35.1,
      scaleMultiplier: 1
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps next-copy and selected-instance sizes independent", () => {
    const controller = new DevPngLabController();
    controller.startPlacement();
    const first = controller.place(-106, 35)!;
    controller.setNextMultiplier(2);
    const second = controller.place(-105, 36)!;
    controller.selectPlacement(first.id);
    controller.setSelectedMultiplier(1.5);

    expect(controller.getSnapshot().placementMode).toBe(true);
    expect(controller.getSnapshot().placements.find(({ id }) => id === first.id)?.scaleMultiplier).toBe(1.5);
    expect(controller.getSnapshot().placements.find(({ id }) => id === second.id)?.scaleMultiplier).toBe(2);
    expect(controller.getSnapshot().nextMultiplier).toBe(2);
    controller.useSelectedSizeForNewCopies();
    expect(controller.getSnapshot().nextMultiplier).toBe(1.5);
  });

  it("moves an existing placement without changing its selected asset or size", () => {
    const controller = new DevPngLabController();
    controller.setNextMultiplier(1.75);
    const placement = controller.place(-106, 35)!;

    controller.movePlacement(placement.id, -105.5, 35.75);

    expect(controller.getSnapshot().placements[0]).toMatchObject({
      id: placement.id,
      assetId: placement.assetId,
      longitude: -105.5,
      latitude: 35.75,
      scaleMultiplier: 1.75
    });
    expect(controller.getSnapshot().selectedPlacementId).toBe(placement.id);
  });

  it("supports duplicate, delete, clear, and session reset", () => {
    const controller = new DevPngLabController();
    controller.startPlacement();
    const placement = controller.place(-106, 35)!;
    controller.selectPlacement(placement.id);
    expect(controller.duplicateSelected()?.id).not.toBe(placement.id);
    controller.deleteSelected();
    expect(controller.getSnapshot().placements).toHaveLength(1);
    controller.clearSelectedAsset();
    expect(controller.getSnapshot().placements).toHaveLength(0);
    controller.place(-106, 35);
    controller.reset();
    expect(controller.getSnapshot().placements).toHaveLength(0);
    expect(controller.getSnapshot().intrinsicSizes).toEqual({});
    expect(controller.getSnapshot().imageFailures).toEqual({});
  });

  it("keeps map-placement image failures isolated and clears them on recovery or deletion", () => {
    const controller = new DevPngLabController();
    const placement = controller.place(-106, 35)!;
    const otherPlacement = controller.place(-105, 36)!;
    const failure = {
      url: "/failed.png",
      sourcePath: "apps/client/public/failed.png",
      message: "PNG failed to load."
    };

    controller.reportImageFailure(placement.id, failure);
    expect(controller.getSnapshot().imageFailures[placement.id]).toEqual(failure);
    expect(controller.getSnapshot().imageFailures[otherPlacement.id]).toBeUndefined();
    controller.clearImageFailure(placement.id);
    expect(controller.getSnapshot().imageFailures[placement.id]).toBeUndefined();
    controller.reportImageFailure(placement.id, failure);
    controller.selectPlacement(placement.id);
    controller.deleteSelected();
    expect(controller.getSnapshot().imageFailures[placement.id]).toBeUndefined();
  });
});
