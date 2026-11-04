// @vitest-environment jsdom

import { RUNTIME_PNG_PRESENTATION_CATALOG } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetStudio } from "./AssetStudio.js";
import type { RuntimeAsset } from "./bridgeTypes.js";
import type { StudioApi } from "./studioApi.js";

vi.mock("../../client/src/ui/IndoorPlayerLayer.js", () => ({
  IndoorPlayerLayer: (props: { className: string; ariaLabel: string }) => (
    <div className={props.className} aria-label={props.ariaLabel} data-player-renderer="canonical" />
  )
}));

describe("Asset Studio mob artwork pair", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows every missing registered Kippen state slot and keeps Add Exact PNG available", async () => {
    const slots = [
      ["siege-packed", "Kippen Siege · Mobile / Idle", "militaryUnits.field_ballista.packed"],
      ["siege-deployed", "Kippen Siege · Deployed / Loading", "militaryUnits.field_ballista.deployed"],
      ["siege-launch", "Kippen Siege · Launch", "militaryUnits.field_ballista.launch"],
      ["bomber-idle", "Kippen Bomber · Idle", "militaryUnits.bomber.idle"],
      ["bomber-planting", "Kippen Bomber · Planting", "militaryUnits.bomber.planting"]
    ] as const;
    const api = {
      loadRuntimeAssets: vi.fn().mockResolvedValue({
        assets: slots.map(([id, label, presentationKey]) =>
          registeredMissingAsset(id, label, presentationKey)),
        presentation: RUNTIME_PNG_PRESENTATION_CATALOG
      }),
      loadRuntimeAssetInbox: vi.fn().mockResolvedValue({
        sourceDirectory: "Documents/AtlasPNGS",
        entries: []
      })
    } as unknown as StudioApi;
    render(<AssetStudio
      api={api}
      visible
      writesAllowed
      onDirtyChange={vi.fn()}
      onBusyChange={vi.fn()}
      onMessage={vi.fn()}
      onOpenAppearance={vi.fn()}
      onPlayerHitGeometryChange={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Game PNG Library" })).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "Search game PNGs" }), {
      target: { value: "KIPPEN" }
    });
    const library = screen.getByRole("listbox", { name: "Game PNGs" });
    expect(within(library).getAllByRole("option")).toHaveLength(slots.length);
    fireEvent.click(within(library).getByRole("option", { name: /Kippen Siege · Mobile \/ Idle/u }));
    expect(screen.getByRole("button", { name: "Add Exact PNG" })).toBeTruthy();
  });

  it("previews a shared item size in phone and desktop contexts", async () => {
    const item = sharedItemAsset();
    const api = {
      loadRuntimeAssets: vi.fn().mockResolvedValue({
        assets: [item],
        presentation: RUNTIME_PNG_PRESENTATION_CATALOG
      }),
      loadRuntimeAssetInbox: vi.fn().mockResolvedValue({
        sourceDirectory: "Documents/AtlasPNGS",
        entries: []
      })
    } as unknown as StudioApi;
    render(<AssetStudio
      api={api}
      visible
      writesAllowed
      onDirtyChange={vi.fn()}
      onBusyChange={vi.fn()}
      onMessage={vi.fn()}
      onOpenAppearance={vi.fn()}
      onPlayerHitGeometryChange={vi.fn()}
    />);

    const preview = await screen.findByRole("region", { name: "Permanent shared item-size preview" });
    expect(within(preview).getByRole("article", { name: "Inventory row context" })).toBeTruthy();
    expect(within(preview).getByRole("article", { name: "Manor floor context" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Drop Size" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "PNG / Inventory Size" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Anchor / Placement" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tap Area / Hitbox" })).toBeTruthy();
    expect(within(preview).getByAltText("Iron Bar inventory preview")).toBeTruthy();
    expect(within(preview).getByAltText("Iron Bar Manor floor preview")).toBeTruthy();
    expect(within(preview).getByTestId("item-display-preview-manor-player").getAttribute("data-player-model")).toBe("PlayerRenderer");
    expect(within(preview).getByRole("tab", { name: "Phone" }).getAttribute("aria-selected")).toBe("true");
    expect(within(preview).getByText(/Draft inventory\/menu size 28px/u)).toBeTruthy();
    expect(preview.getAttribute("data-draft-ground-height-px")).toBe("28");
    expect(preview.getAttribute("data-draft-inventory-height-px")).toBe("28");
    const inventoryRow = within(preview).getByTestId("item-display-preview-inventory-row");
    expect(inventoryRow.getAttribute("data-inventory-frame")).toBe("34");
    const artwork = within(preview).getByAltText("Iron Bar inventory preview") as HTMLImageElement;
    expect(artwork.style.transform).toBe("scale(1)");
    fireEvent.change(screen.getByLabelText("Ground-drop size (px)"), { target: { value: "56" } });
    expect(within(preview).getByText(/ground-drop size 56px/u)).toBeTruthy();
    expect(preview.getAttribute("data-draft-ground-height-px")).toBe("56");
    expect(preview.getAttribute("data-draft-inventory-height-px")).toBe("56");
    expect(within(preview).getByTestId("item-display-preview-manor-drop").getAttribute("data-ground-frame")).toBe("140");
    expect((within(preview).getByAltText("Iron Bar inventory preview") as HTMLImageElement).style.transform).toBe("scale(2)");
    fireEvent.change(screen.getByLabelText("Inventory/menu artwork size (px)"), { target: { value: "14" } });
    expect(preview.getAttribute("data-draft-inventory-height-px")).toBe("14");
    expect((within(preview).getByAltText("Iron Bar inventory preview") as HTMLImageElement).style.transform).toBe("scale(0.5)");
    expect(screen.getByLabelText("Inventory/menu artwork size (px)")).toBeTruthy();
    expect(screen.getByLabelText("Lock hitbox to ground size")).toBeTruthy();
    expect((screen.getByLabelText("Hit width (frame)") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Lock hitbox to ground size"));
    expect((screen.getByLabelText("Hit width (frame)") as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Hit width (frame)"), { target: { value: "0.7" } });
    fireEvent.click(screen.getByLabelText("Lock hitbox to ground size"));
    expect((screen.getByLabelText("Hit width (frame)") as HTMLInputElement).disabled).toBe(true);
    expect(within(preview).getByTestId("item-display-preview-manor-drop")).toBeTruthy();
    fireEvent.click(within(preview).getByRole("tab", { name: "Desktop" }));
    expect(within(preview).getByRole("tab", { name: "Desktop" }).getAttribute("aria-selected")).toBe("true");
    expect(within(preview).getByTestId("item-display-preview-device").className).toContain("desktop");
    expect(within(preview).getByTestId("item-display-preview-inventory-row").getAttribute("data-inventory-frame")).toBe("34");
  });

  it("opens a live large companion preview without duplicating the draft editor", async () => {
    const item = sharedItemAsset();
    const api = {
      loadRuntimeAssets: vi.fn().mockResolvedValue({
        assets: [item],
        presentation: RUNTIME_PNG_PRESENTATION_CATALOG
      }),
      loadRuntimeAssetInbox: vi.fn().mockResolvedValue({
        sourceDirectory: "Documents/AtlasPNGS",
        entries: []
      })
    } as unknown as StudioApi;
    const popupDocument = document.implementation.createHTMLDocument("item preview");
    const popup = {
      document: popupDocument,
      closed: false,
      close: vi.fn(),
      focus: vi.fn()
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    render(<AssetStudio
      api={api}
      visible
      writesAllowed
      onDirtyChange={vi.fn()}
      onBusyChange={vi.fn()}
      onMessage={vi.fn()}
      onOpenAppearance={vi.fn()}
      onPlayerHitGeometryChange={vi.fn()}
    />);

    const preview = await screen.findByRole("region", { name: "Permanent shared item-size preview" });
    fireEvent.click(within(preview).getByRole("button", { name: "Open large preview" }));
    const large = popupDocument.querySelector<HTMLElement>("[data-testid='item-display-preview-large']");
    expect(large).toBeTruthy();
    expect(large?.querySelector("[aria-label='Inventory row context']")).toBeTruthy();
    expect(large?.querySelector("[aria-label='Manor floor context']")).toBeTruthy();
    expect(large?.getAttribute("data-draft-ground-height-px")).toBe("28");

    fireEvent.change(screen.getByLabelText("Ground-drop size (px)"), { target: { value: "56" } });
    expect(large?.getAttribute("data-draft-ground-height-px")).toBe("56");
    expect(popup.focus).toHaveBeenCalled();
  });

  it("keeps the large preview wide at desktop sizes and stacks it without overflow when narrow", () => {
    const studioStyles = readFileSync("src/styles.css", "utf8");
    expect(studioStyles).toMatch(/\.item-display-preview--large \.item-display-preview-device\s*\{[^}]*width: 100%;[^}]*max-width: none;/u);
    expect(studioStyles).toMatch(/\.item-display-preview--large \.item-display-preview-contexts,[\s\S]*?grid-template-columns: repeat\(auto-fit, minmax\(420px, 1fr\)\)/u);
    expect(studioStyles).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.item-display-preview--large \.item-display-preview-contexts,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u);
  });
});

function sharedItemAsset(): RuntimeAsset {
  return {
    id: "apps/client/src/assets/items/iron-bar.png",
    label: "Iron Bar",
    category: "Items & Materials",
    relativeFile: "apps/client/src/assets/items/iron-bar.png",
    imageUrl: "/runtime-assets/apps/client/src/assets/items/iron-bar.png",
    width: 1254,
    height: 1254,
    bytes: 1254,
    contentHash: "b".repeat(64),
    usages: [{
      id: "production-0",
      label: "Item Artwork — Shared Size",
      context: "Permanent runtime size authored here and shared by inventory, menus, and every ground-drop scene",
      editor: { kind: "sprite", key: "iron_bar" }
    }],
    staged: false,
    missing: false
  };
}

function registeredMissingAsset(id: string, label: string, presentationKey: string): RuntimeAsset {
  const relativeFile = `apps/client/src/assets/military/units/${id}.png`;
  return {
    id: relativeFile,
    label,
    category: "Military",
    relativeFile,
    imageUrl: "",
    width: 0,
    height: 0,
    bytes: 0,
    contentHash: "",
    usages: [{
      id: `production-${id}`,
      label,
      context: "World military unit group",
      editor: { kind: "sprite", key: presentationKey }
    }],
    staged: false,
    missing: true
  };
}
