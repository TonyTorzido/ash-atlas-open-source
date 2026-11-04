// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_PNG_ASSETS } from "../developer/devPngCatalog.js";
import { DevPngLabController } from "../developer/devPngLabController.js";
import { RUNTIME_PNG_PRESENTATION_CATALOG } from "@ash-atlas/shared";
import { DeveloperPngLab } from "./DeveloperPngLab.js";

afterEach(cleanup);

describe("Developer PNG Lab", () => {
  it("previews and resets the World PNG Master Scale", () => {
    const controller = new DevPngLabController();
    renderLab(controller);
    const slider = screen.getByRole("slider", { name: "World PNG Master Scale" });
    fireEvent.change(slider, { target: { value: "1.75" } });
    expect(controller.getSnapshot().masterScale).toBe(1.75);
    expect((screen.getByRole("spinbutton", {
      name: "World PNG Master Scale value"
    }) as HTMLInputElement).value).toBe("1.75");
    fireEvent.click(screen.getByRole("button", { name: /Reset to/ }));
    expect(controller.getSnapshot().masterScale).toBe(RUNTIME_PNG_PRESENTATION_CATALOG.masterScale);
  });

  it("searches, filters placeable assets, and updates the inspector", () => {
    const controller = new DevPngLabController();
    renderLab(controller);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search PNGs" }), { target: { value: "wolf.png" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Wolf/ })[0]!);
    expect(screen.getByRole("heading", { name: "Wolf" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Placeable only" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "App Icons" } });
    expect(screen.getByText("No PNG assets match this filter.")).toBeTruthy();
  });

  it("shows intrinsic, production, and sizing-authority dimensions separately", () => {
    const controller = new DevPngLabController();
    const wolf = DEV_PNG_ASSETS.find(({ id }) => id.includes("wolf-png--world-mob"))!;
    controller.selectAsset(wolf.id);
    renderLab(controller);
    const preview = screen.getByAltText("Wolf preview");
    Object.defineProperties(preview, {
      naturalWidth: { configurable: true, value: 512 },
      naturalHeight: { configurable: true, value: 768 }
    });
    fireEvent.load(preview);
    expect(screen.getByText("512 × 768 px")).toBeTruthy();
    expect(screen.getByText(/at zoom 14\.00/)).toBeTruthy();
    expect(screen.getByText("Sizing authority")).toBeTruthy();
  });

  it("keeps permanent item sizing in Appearance Studio and labels Lab changes temporary", () => {
    const controller = new DevPngLabController();
    const item = DEV_PNG_ASSETS.find(({ productionSize }) => productionSize?.kind === "item-scaled")!;
    controller.selectAsset(item.id);
    renderLab(controller);

    expect(screen.getByText(/Permanent item-size authoring lives in Appearance Studio → Game PNGs/u)).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Temporary next placement size" })).toBeTruthy();
    expect(screen.getByText(/Permanent item size is authored in Appearance Studio/u)).toBeTruthy();
  });

  it("labels missing PNGs as compact diagnostic placeholders", () => {
    const controller = new DevPngLabController();
    renderLab(controller);
    const preview = screen.getByAltText(/preview/);
    fireEvent.error(preview);

    expect(screen.getAllByText("⚠ Missing PNG").length).toBeGreaterThan(0);
    expect(screen.getByText(/diagnostic only and does not represent the asset’s real size/i)).toBeTruthy();
  });

  it("keeps selected-instance changes separate from the next placement size", () => {
    const controller = new DevPngLabController();
    renderLab(controller);
    const nextSlider = screen.getByRole("slider", { name: "Next placement size" });
    fireEvent.change(nextSlider, { target: { value: "1.35" } });
    expect((screen.getByRole("spinbutton", { name: "Multiplier" }) as HTMLInputElement).value).toBe("1.35");

    let placement!: NonNullable<ReturnType<DevPngLabController["place"]>>;
    act(() => { placement = controller.place(-106, 35)!; });
    expect(placement.scaleMultiplier).toBe(1.35);
    const selectedSlider = screen.getByRole("slider", { name: "Selected instance size" });
    fireEvent.change(selectedSlider, { target: { value: "2" } });
    expect(controller.getSnapshot().placements[0]?.scaleMultiplier).toBe(2);
    expect(controller.getSnapshot().nextMultiplier).toBe(1.35);
    fireEvent.click(screen.getByRole("button", { name: "Use This Size for New Copies" }));
    expect(controller.getSnapshot().nextMultiplier).toBe(2);
  });

  it("uses the styled confirmation dialog before clearing all", () => {
    const controller = new DevPngLabController();
    controller.place(-106, 35);
    renderLab(controller);
    fireEvent.click(screen.getByRole("button", { name: "Clear All PNGs" }));
    expect(screen.getByRole("dialog", { name: "Clear all local PNGs?" })).toBeTruthy();
    expect(controller.getSnapshot().placements).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Clear all local PNGs?" })).getByRole("button", { name: "Clear All PNGs" }));
    expect(controller.getSnapshot().placements).toHaveLength(0);
  });
});

function renderLab(controller: DevPngLabController): void {
  render(<DeveloperPngLab controller={controller} mapZoom={14} playerPosition={{ longitude: -106, latitude: 35 }} onStartPlacement={() => controller.startPlacement()} onCenterSelected={vi.fn()} />);
}
