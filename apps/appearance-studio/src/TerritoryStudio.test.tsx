// @vitest-environment jsdom
import { act, createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERRITORY_STRUCTURE_CATALOG, type TerritoryStructureCatalog } from "@ash-atlas/shared";
import { TerritoryStudio, type TerritoryStudioHandle } from "./TerritoryStudio.js";
import type { StudioApi } from "./studioApi.js";

vi.mock("./TerritoryPreview.js", () => ({ TerritoryPreview: () => <div>Shared game preview</div> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

describe("Flags Studio", () => {
  it("edits whole roots and independent targets for every type, saves, and reloads a newer disk revision", async () => {
    let disk = structuredClone(TERRITORY_STRUCTURE_CATALOG);
    const availableAssets = Object.values(disk.packs.stock!.structures).flatMap((visual) => visual!.pieces.map((piece) => piece.asset));
    const loadTerritoryStructures = vi.fn(async () => ({ catalog: disk, availableAssets }));
    const publishTerritoryStructures = vi.fn(async (catalog: TerritoryStructureCatalog) => {
      disk = structuredClone({ ...catalog, revision: catalog.revision + 1 });
      return { catalog: disk, inventory: { catalog: disk, availableAssets }, modifiedFiles: ["catalog.json"] };
    });
    const api = { loadTerritoryStructures, publishTerritoryStructures } as unknown as StudioApi;
    const ref = createRef<TerritoryStudioHandle>();
    render(<TerritoryStudio ref={ref} api={api} visible writesAllowed onDirtyChange={vi.fn()} onBusyChange={vi.fn()} onMessage={vi.fn()} />);
    await screen.findByRole("heading", { name: "Soft Flag" });
    for (const name of ["Soft Flag", "Bastion Flag", "Tower", "Atlas Shrine"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      fireEvent.change(screen.getByLabelText("Master Scale"), { target: { value: "0.6" } });
      fireEvent.change(screen.getByLabelText("Master X offset"), { target: { value: "2" } });
      fireEvent.change(screen.getByLabelText("Interaction height"), { target: { value: "64" } });
    }
    await act(async () => ref.current?.save());
    expect(publishTerritoryStructures).toHaveBeenCalledTimes(1);
    for (const visual of Object.values(disk.packs.stock!.structures)) expect(visual!.root).toMatchObject({ scale: 0.6, offsetX: 2 });
    expect(disk.structures.soft_flag!.interaction.height).toBe(64);
    fireEvent.change(screen.getByLabelText("Master Scale"), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toContain("Fix before saving");
    await act(async () => ref.current?.save());
    expect(publishTerritoryStructures).toHaveBeenCalledTimes(1);
    disk.revision += 1;
    disk.packs.stock!.structures.atlas_shrine!.root.scale = 0.9;
    await act(async () => ref.current?.revert());
    expect((screen.getByLabelText("Master Scale") as HTMLInputElement).value).toBe("0.9");
  });

  it("keeps read-only workspaces from publishing", async () => {
    const publishTerritoryStructures = vi.fn();
    const api = { loadTerritoryStructures: async () => ({
      catalog: TERRITORY_STRUCTURE_CATALOG,
      availableAssets: Object.values(TERRITORY_STRUCTURE_CATALOG.packs.stock!.structures).flatMap((visual) => visual!.pieces.map((piece) => piece.asset))
    }), publishTerritoryStructures } as unknown as StudioApi;
    const ref = createRef<TerritoryStudioHandle>();
    render(<TerritoryStudio ref={ref} api={api} visible writesAllowed={false} onDirtyChange={vi.fn()} onBusyChange={vi.fn()} onMessage={vi.fn()} />);
    await screen.findByRole("heading", { name: "Soft Flag" });
    fireEvent.change(screen.getByLabelText("Master Scale"), { target: { value: "0.5" } });
    await act(async () => ref.current?.save());
    expect(publishTerritoryStructures).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "New pack / Clone Stock" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clones a complete recolored pack, edits real layers and overlays, and round-trips the active cosmetic pack", async () => {
    let disk = structuredClone(TERRITORY_STRUCTURE_CATALOG);
    const originalStock = structuredClone(disk.packs.stock);
    const originalTypes = structuredClone(disk.structures);
    const availableAssets = Object.values(disk.packs.stock!.structures).flatMap((visual) => visual!.pieces.map((piece) => piece.asset));
    const publishTerritoryStructures = vi.fn(async (catalog: TerritoryStructureCatalog) => {
      disk = structuredClone({ ...catalog, revision: catalog.revision + 1 });
      return { catalog: disk, inventory: { catalog: disk, availableAssets }, modifiedFiles: ["catalog.json"] };
    });
    const api = { loadTerritoryStructures: async () => ({ catalog: disk, availableAssets }), publishTerritoryStructures } as unknown as StudioApi;
    const ref = createRef<TerritoryStudioHandle>();
    render(<TerritoryStudio ref={ref} api={api} visible writesAllowed onDirtyChange={vi.fn()} onBusyChange={vi.fn()} onMessage={vi.fn()} />);
    await screen.findByRole("heading", { name: "Soft Flag" });
    fireEvent.click(screen.getByRole("button", { name: "New pack / Clone Stock" }));
    fireEvent.change(screen.getByLabelText("New pack ID"), { target: { value: "violet" } });
    fireEvent.change(screen.getByLabelText("New pack name"), { target: { value: "Violet Banner" } });
    fireEvent.click(screen.getByLabelText("Use fixed cloth color"));
    fireEvent.change(screen.getByLabelText("New pack cloth color"), { target: { value: "#9933cc" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft pack" }));
    expect((screen.getByLabelText("Flag pack") as HTMLSelectElement).value).toBe("violet");
    fireEvent.click(screen.getByRole("button", { name: /^Soft flag cloth/ }));
    expect((screen.getByLabelText("Component tint") as HTMLSelectElement).value).toBe("fixed");
    fireEvent.change(screen.getByLabelText("Component scale"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByLabelText("Component visible"));
    expect(screen.getByRole("alert").textContent).toContain("visible cloth");
    await act(async () => ref.current?.save());
    expect(publishTerritoryStructures).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Component visible"));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate component" }));
    fireEvent.change(screen.getByLabelText("Component name"), { target: { value: "Banner trim" } });
    fireEvent.change(screen.getByLabelText("Component role"), { target: { value: "decoration" } });
    fireEvent.change(screen.getByLabelText("Component offsetX"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText("Component visible"));
    fireEvent.click(screen.getByRole("button", { name: "Move backward" }));
    fireEvent.click(screen.getByRole("button", { name: "Add PNG component" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove component" }));
    fireEvent.click(screen.getByRole("button", { name: /^Burning indicator/ }));
    fireEvent.change(screen.getByLabelText("Overlay scale"), { target: { value: "1.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Use pack in game" }));
    await act(async () => ref.current?.save());
    expect(publishTerritoryStructures).toHaveBeenCalledTimes(1);
    expect(disk.defaultPackId).toBe("violet");
    expect(Object.keys(disk.packs.violet!.structures)).toHaveLength(4);
    expect(disk.packs.violet!.structures.soft_flag!.pieces).toHaveLength(3);
    expect(disk.packs.violet!.structures.soft_flag!.pieces[2]).toMatchObject({ id: "cloth-copy-1", name: "Banner trim", role: "decoration", visible: false, offsetX: 4 });
    expect(disk.packs.violet!.structures.soft_flag!.attachments.burning.scale).toBe(1.2);
    expect(disk.packs.stock).toEqual(originalStock);
    expect(disk.structures).toEqual(originalTypes);
    await act(async () => ref.current?.revert());
    expect((screen.getByLabelText("Flag pack") as HTMLSelectElement).value).toBe("violet");
    expect((screen.getByRole("button", { name: "Active game pack" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
