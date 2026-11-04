// @vitest-environment jsdom
import type { WorldEnvironmentOverlayGroupId } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultWorldEnvironmentOverlaySelections,
  setWorldEnvironmentOverlayCategory
} from "../map/worldEnvironmentOverlays.js";
import { WorldMapLayerControl } from "./WorldMapLayerControl.js";

afterEach(cleanup);

describe("WorldMapLayerControl", () => {
  it("keeps one active group, multiple category checks, bulk actions, and state after menu close", () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      const [activePanel, setActivePanel] = useState<WorldEnvironmentOverlayGroupId>("environment");
      const [activeOverlay, setActiveOverlay] = useState<WorldEnvironmentOverlayGroupId | null>(null);
      const [selections, setSelections] = useState(
        createDefaultWorldEnvironmentOverlaySelections
      );
      return <>
        <button type="button" onClick={() => setOpen((current) => !current)}>Layers</button>
        <WorldMapLayerControl
          open={open}
          activePanelId={activePanel}
          activeOverlayGroupId={activeOverlay}
          selections={selections}
          error={null}
          onPanelChange={setActivePanel}
          onActiveGroupChange={setActiveOverlay}
          onCategoryChange={(groupId, categoryId, enabled) => setSelections((current) =>
            setWorldEnvironmentOverlayCategory(current, groupId, categoryId, enabled)
          )}
        />
      </>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect(screen.getByRole("region", { name: "Layers" })).toBeTruthy();
    expect(screen.queryByText(/Broad travel guidance only/)).toBeNull();
    expect(screen.queryByRole("tab", { name: "Destinations" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Biomes" }).textContent).toBe("Biomes");
    expect(screen.getByRole("tab", { name: "Ocean Depth" }).textContent).toBe("Ocean Depth");
    expect(screen.getByRole("tab", { name: "Water" }).textContent).toBe("Water");
    fireEvent.click(screen.getByRole("tab", { name: "Biomes" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(13);
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByRole("button", { name: "Select All" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear All" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tundra" }));
    expect((screen.getByRole("checkbox", { name: "Frozen Waste" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Water" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect((screen.getByRole("checkbox", { name: "Rivers" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Lakes" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Lakes" }));
    expect((screen.getByRole("checkbox", { name: "Rivers" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Lakes" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Elevation" }));
    expect(screen.queryByRole("checkbox", { name: "Tundra" })).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    fireEvent.click(screen.getByRole("tab", { name: "Biomes" }));
    expect((screen.getByRole("checkbox", { name: "Tundra" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Close Layers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Layers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect((screen.getByRole("checkbox", { name: "Tundra" }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the phone popover compact and inside the map control", () => {
    const behindPointerDown = vi.fn();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return <div onPointerDown={behindPointerDown}>
        <button type="button" onClick={() => setOpen((current) => !current)}>Layers</button>
        <WorldMapLayerControl
          layout="phone"
          open={open}
          activePanelId="environment"
          activeOverlayGroupId="environment"
          selections={createDefaultWorldEnvironmentOverlaySelections()}
          error={null}
          onPanelChange={() => undefined}
          onActiveGroupChange={() => undefined}
          onCategoryChange={() => undefined}
        />
      </div>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    const popover = screen.getByRole("region", { name: "Layers" });
    expect(popover.closest(".world-map-layer-control--phone")).toBeTruthy();
    expect(document.querySelector(".world-map-layer-backdrop")).toBeNull();
    fireEvent.pointerDown(popover);
    expect(behindPointerDown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
  });

  it("shows asset failures without replacing the control", () => {
    render(<WorldMapLayerControl
      open
      activePanelId="environment"
      activeOverlayGroupId="environment"
      selections={createDefaultWorldEnvironmentOverlaySelections()}
      error="Tundra could not be loaded. The World Map remains available."
      onPanelChange={() => undefined}
      onActiveGroupChange={() => undefined}
      onCategoryChange={() => undefined}
    />);
    expect(screen.getByRole("status").textContent).toContain("World Map remains available");
    expect(screen.queryByRole("button", { name: "Close Layers" })).toBeNull();
  });
});
