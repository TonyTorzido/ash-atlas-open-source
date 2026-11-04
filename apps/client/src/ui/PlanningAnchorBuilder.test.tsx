// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanningAnchor, PlanningAnchorLayer, PlanningAnchorSource } from "../map/planningAnchors.js";
import { PlanningAnchorBuilder } from "./PlanningAnchorBuilder.js";

afterEach(() => cleanup());

const source: PlanningAnchorSource = {
  kind: "flag",
  id: "tower-1",
  label: "Test Tower",
  position: { lat: 35, lon: -106 }
};
const layers: readonly PlanningAnchorLayer[] = [
  { id: "main", name: "Main", visible: true },
  { id: "siege", name: "Siege", visible: false }
];
const anchors: readonly PlanningAnchor[] = [{
  id: "anchor-1",
  layerId: "main",
  number: 1,
  source,
  distanceM: 575,
  position: { lat: 35.005, lon: -106 },
  createdAt: 1
}];

function renderBuilder(overrides: Partial<React.ComponentProps<typeof PlanningAnchorBuilder>> = {}) {
  return render(<PlanningAnchorBuilder
    mode="anchor"
    source={source}
    distanceInput="575"
    distanceM={575}
    draft={null}
    layers={layers}
    anchors={anchors}
    selectedLayerId="main"
    newLayerName=""
    canCreateLayer={false}
    layersOpen={false}
    clearConfirmOpen={false}
    onDistanceInputChange={vi.fn()}
    onSetDistance={vi.fn()}
    onLayerChange={vi.fn()}
    onToggleLayer={vi.fn()}
    onNewLayerNameChange={vi.fn()}
    onCreateLayer={vi.fn()}
    onClearLayer={vi.fn()}
    onCloseLayers={vi.fn()}
    onCloseClearConfirmation={vi.fn()}
    onAddDraft={vi.fn()}
    onCancelDraft={vi.fn()}
    {...overrides}
  />);
}

describe("PlanningAnchorBuilder", () => {
  it("keeps the meter surface persistent", () => {
    const onSetDistance = vi.fn();
    renderBuilder({ onSetDistance });

    expect(screen.queryByText("Builder")).toBeNull();
    expect(screen.queryByText("Anchor Settings")).toBeNull();
    expect(screen.queryByText("Select a flag, tower, city, or saved anchor.")).toBeNull();
    const meter = screen.getByRole("spinbutton", { name: "Anchor distance in meters" }) as HTMLInputElement;
    expect(meter.value).toBe("575");
    expect(meter.classList.contains("planning-anchor-meter-input")).toBe(true);
    expect(screen.queryByText("575m")).toBeNull();
    expect(screen.queryByText("m", { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Set distance" }).classList.contains("planning-anchor-meter-apply")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Set distance" }));
    expect(onSetDistance).toHaveBeenCalledOnce();
  });

  it("uses themed distance stepper buttons without changing the accessible meter field", () => {
    const onDistanceInputChange = vi.fn();
    renderBuilder({ onDistanceInputChange });

    const meter = screen.getByRole("spinbutton", { name: "Anchor distance in meters" });
    expect(meter.closest(".planning-anchor-distance-stepper")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decrease anchor distance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Increase anchor distance" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Decrease anchor distance" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase anchor distance" }));
    expect(onDistanceInputChange).toHaveBeenNthCalledWith(1, "574.99");
    expect(onDistanceInputChange).toHaveBeenNthCalledWith(2, "575.01");
  });

  it("caps layers and confirms clear-current-layer without marker deletion", () => {
    const onClearLayer = vi.fn();
    const onCloseLayers = vi.fn();
    const onCloseClearConfirmation = vi.fn();
    const onToggleLayer = vi.fn();
    const threeLayers = [...layers, { id: "third", name: "Third", visible: true }];
    renderBuilder({
      layers: threeLayers,
      layersOpen: true,
      onCloseLayers,
      canCreateLayer: false,
      onToggleLayer
    });

    expect(screen.getByText("3/3 · Main")).toBeTruthy();
    expect(screen.getByText("Layer cap reached (3).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create layer" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Select layer Main" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Hide layer Main" }));
    expect(onToggleLayer).toHaveBeenCalledWith("main", false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCloseLayers).toHaveBeenCalledOnce();

    cleanup();
    renderBuilder({
      layers: threeLayers,
      clearConfirmOpen: true,
      onClearLayer,
      onCloseClearConfirmation
    });
    expect(screen.getByText("Clear current layer?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClearLayer).not.toHaveBeenCalled();
    expect(onCloseClearConfirmation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear Current Layer" }));
    expect(onClearLayer).toHaveBeenCalledOnce();
    expect(onCloseClearConfirmation).toHaveBeenCalledTimes(2);
  });

  it("keeps add/cancel draft actions compact and hides meter controls in select mode", () => {
    const onAddDraft = vi.fn();
    const onCancelDraft = vi.fn();
    const { rerender } = renderBuilder({
      draft: { source, distanceM: 575, position: { lat: 35.005, lon: -106 } },
      onAddDraft,
      onCancelDraft
    });
    expect(screen.getByRole("dialog", { name: "Add Anchor? actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Anchor" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAddDraft).toHaveBeenCalledOnce();
    expect(onCancelDraft).toHaveBeenCalledOnce();

    rerender(<PlanningAnchorBuilder
      mode="select"
      source={null}
      distanceInput="575"
      distanceM={575}
      draft={null}
      layers={layers}
      anchors={anchors}
      selectedLayerId="main"
      newLayerName=""
      canCreateLayer={false}
      layersOpen={false}
      clearConfirmOpen={false}
      onDistanceInputChange={vi.fn()}
      onSetDistance={vi.fn()}
      onLayerChange={vi.fn()}
      onToggleLayer={vi.fn()}
      onNewLayerNameChange={vi.fn()}
      onCreateLayer={vi.fn()}
      onClearLayer={vi.fn()}
      onCloseLayers={vi.fn()}
      onCloseClearConfirmation={vi.fn()}
      onAddDraft={vi.fn()}
      onCancelDraft={vi.fn()}
    />);
    expect(screen.queryByRole("spinbutton", { name: "Anchor distance in meters" })).toBeNull();
  });
});
