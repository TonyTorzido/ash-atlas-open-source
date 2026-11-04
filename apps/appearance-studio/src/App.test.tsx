// @vitest-environment jsdom

import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  ITEM_VARIANT_CATALOG,
  interiorCatalogFromLegacy,
  playerMainAnchor,
  RUNTIME_PNG_PRESENTATION_CATALOG,
  type EquipmentDefinitionId,
  type PlayerAppearanceCatalog
} from "@ash-atlas/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", () => ({
  Application: class {},
  Container: class {},
  Graphics: class {}
}));
vi.mock("@ash-atlas/player-renderer", () => ({ PlayerRenderer: class {} }));

vi.mock("./PreviewCanvas.js", () => ({
  PreviewCanvas: ({
    selected,
    overlayAppearanceIds,
    enhancementPreview,
    showGemstonePreview,
    showGuides,
    onDrag,
    onDragPivot,
    onMoveGemSocket,
    onSelectAnchor,
    onMovePlayerHitCenter
  }: {
    selected: { appearanceId: string } | null;
    overlayAppearanceIds: string[];
    enhancementPreview: { gemstone: string; coreId: string | null } | null;
    showGemstonePreview: boolean;
    showGuides: boolean;
    onDrag(x: number, y: number, anchorId?: "face"): void;
    onDragPivot(x: number, y: number, pivotX: number, pivotY: number): void;
    onMoveGemSocket(x: number, y: number): void;
    onSelectAnchor(anchorId: "face"): void;
    onMovePlayerHitCenter(centerX: number, centerY: number): void;
  }) => (
    <>
      <span data-testid="preview-selection">
        {selected?.appearanceId ?? "No item selected"}
      </span>
      <span data-testid="preview-overlays">{overlayAppearanceIds.join(",")}</span>
      <span data-testid="preview-enhancement">{JSON.stringify(enhancementPreview)}</span>
      <span data-testid="preview-gem-visible">{String(showGemstonePreview)}</span>
      <span data-testid="preview-guides">{String(showGuides)}</span>
      <button type="button" onClick={() => onDrag(1, 0)}>Preview drag</button>
      <button type="button" onClick={() => onDragPivot(1, 2, 0.3, 0.4)}>
        Pivot drag
      </button>
      <button type="button" onClick={() => onMoveGemSocket(0.2, 0.65)}>Gem drag</button>
      <button type="button" onClick={() => {
        onSelectAnchor("face");
        onDrag(2, 3, "face");
      }}>Anchor drag</button>
      <button type="button" onClick={() => onDrag(2, 3)}>Main drag</button>
      <button type="button" onClick={() => onMovePlayerHitCenter(0.2, 0.3)}>
        Touch box drag
      </button>
    </>
  )
}));

vi.mock("./BossPreviewCanvas.js", () => ({
  BossPreviewCanvas: ({
    bossId,
    poseId,
    onDragPivot
  }: {
    bossId: string;
    poseId: string;
    onDragPivot(x: number, y: number, pivotX: number, pivotY: number): void;
  }) => (
    <>
      <span data-testid="boss-preview">{bossId}:{poseId}</span>
      <button type="button" onClick={() => onDragPivot(1, 2, 0.3, 0.4)}>
        Boss pivot drag
      </button>
    </>
  )
}));

import {
  App,
  appearanceSupportsGem,
  poseLabel,
  resetPlayerMainAnchor,
  withImportedPlayerTemplateAsset,
  withPlayerAnchorPosition,
  withPlayerMainAnchor,
  withPlayerOverallScale,
  withPlayerTemplateTransform
} from "./App.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Appearance Studio UI", () => {
  it("does not nudge or undo hidden Appearance drafts from another workspace", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    const before = (screen.getByLabelText("Offset X") as HTMLInputElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Interiors" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe(before);
    expect(screen.getByRole("button", { name: "Save to Worktree" }).hasAttribute("disabled")).toBe(true);
  });

  it("uses four distinct canonical player pose labels", () => {
    expect(["idle", "combat_ready", "attack_action", "downed"].map((pose) =>
      poseLabel(pose as never)
    )).toEqual(["Idle", "Ready", "Action", "Downed"]);
  });

  it("separates Player Overlays from Gear and exposes the exact overlay slots", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    expect(screen.getByRole("tab", { name: "Gear" }).getAttribute("aria-selected"))
      .toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    const library = screen.getByRole("navigation", { name: "Appearance categories" });
    expect(within(library).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Face", "Mask", "Hair", "Legs", "Beard"]);
    expect(screen.getAllByRole("button", { name: "Action" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Downed" })).toBeTruthy();
    expect(within(library).queryByRole("button", { name: "Chest" })).toBeNull();
    const family = screen.getByLabelText("Overlay family") as HTMLSelectElement;
    expect(within(family).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Eyes", "Nose", "Mouth"]);
    expect(within(library).queryByRole("button", { name: "Eyes" })).toBeNull();
    expect(screen.queryByText("Nose / Mouth")).toBeNull();

    fireEvent.click(within(library).getByRole("button", { name: "Beard" }));
    expect(screen.getByText("Avatar style — independent of equipment.")).toBeTruthy();
  });

  it("keeps preview guides shown by default and toggles them without changing the preview", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    const guides = screen.getByLabelText("Show guides") as HTMLInputElement;
    expect(guides.checked).toBe(true);
    expect(screen.getByTestId("preview-guides").textContent).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Preview Overlays (0)" }));
    fireEvent.change(screen.getByLabelText("Overlay appearance"), {
      target: { value: "hair_test" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Overlay" }));
    expect(screen.getByTestId("preview-overlays").textContent).toBe("hair_test");
    expect(screen.getByText(/PREVIEW OVERLAY.*NOT SAVED/u)).toBeTruthy();

    fireEvent.click(guides);
    expect(guides.checked).toBe(false);
    expect(screen.getByTestId("preview-guides").textContent).toBe("false");
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");
    expect(screen.getByTestId("preview-overlays").textContent).toBe("hair_test");
    expect(screen.queryByText(/PREVIEW OVERLAY.*NOT SAVED/u)).toBeNull();
  });

  it("keeps weapon and shield overlay targets fixed while armor remains selectable", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    const weaponOverlay = screen.getByLabelText("Player overlay") as HTMLSelectElement;
    expect(weaponOverlay.value).toBe("");
    expect(weaponOverlay.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Shields" }));
    const shieldOverlay = screen.getByLabelText("Player overlay") as HTMLSelectElement;
    expect(shieldOverlay.value).toBe("shield");
    expect(shieldOverlay.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Body Armor" }));
    const armorOverlay = screen.getByLabelText("Player overlay") as HTMLSelectElement;
    expect(armorOverlay.value).toBe("chest");
    expect(armorOverlay.disabled).toBe(false);
    expect(within(armorOverlay).queryByRole("option", { name: "None" })).toBeNull();
    fireEvent.change(armorOverlay, { target: { value: "legs" } });
    expect((screen.getByLabelText("Player overlay") as HTMLSelectElement).value).toBe("legs");
    expect((screen.getByLabelText("Anchor") as HTMLSelectElement).value).toBe("legs");
  });
  it("updates the combined player template for the selected pose", () => {
    const catalog = studioCatalog();
    const edited = withImportedPlayerTemplateAsset(
      catalog,
      "combat_ready",
      "bodies/player-ready.png"
    );
    const template = edited.bodyVariants.find(
      ({ bodyVariantId }) => bodyVariantId === "default"
    );
    expect(template
      ?.bodyAssetKeys?.combat_ready).toBe("bodies/player-ready.png");
  });

  it("stores the template transform and shares authored anchors across poses", () => {
    const catalog = studioCatalog();
    const transformed = withPlayerTemplateTransform(catalog, "idle", {
      offsetX: 4,
      offsetY: -3,
      scale: 1.25
    });
    const anchored = withPlayerAnchorPosition(
      transformed,
      "idle",
      "face",
      7,
      -31
    );
    const template = anchored.bodyVariants[0]!;
    expect(template.bodyTransforms?.idle).toEqual({
      offsetX: 4,
      offsetY: -3,
      scale: 1.25
    });
    expect(template.poses.every((pose) =>
      pose.anchors.face.x === 7 && pose.anchors.face.y === -31
    )).toBe(true);
    expect(withPlayerOverallScale(anchored, 1.5).bodyVariants[0]?.overallScale)
      .toBe(1.5);
    const mainAnchored = withPlayerMainAnchor(anchored, 4, 30);
    expect(mainAnchored.bodyVariants[0]?.mainAnchor).toEqual({ x: 4, y: 30 });
    expect(mainAnchored.bodyVariants[0]?.poses).toEqual(anchored.bodyVariants[0]?.poses);
    expect(resetPlayerMainAnchor(mainAnchored).bodyVariants[0]?.mainAnchor)
      .toEqual(playerMainAnchor(DEFAULT_PLAYER_APPEARANCE_CATALOG, "default"));
  });

  it("edits template placement and anchors directly from preview setup modes", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 34 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");

    fireEvent.click(screen.getByRole("button", { name: "Item Pivot" }));
    fireEvent.click(screen.getByRole("button", { name: "Pivot drag" }));
    expect((screen.getByLabelText("Pivot X") as HTMLInputElement).value).toBe("0.3");
    expect((screen.getByLabelText("Pivot Y") as HTMLInputElement).value).toBe("0.4");
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");

    fireEvent.click(screen.getByRole("button", { name: "Master Scale" }));
    fireEvent.change(screen.getByLabelText("Master scale"), {
      target: { value: "1.5" }
    });
    expect((screen.getByLabelText("Master scale") as HTMLInputElement).value).toBe("1.5");
    expect(screen.getByTestId("preview-selection").textContent).toBe("No item selected");

    fireEvent.click(screen.getByRole("button", { name: "Base Body" }));
    expect(screen.getByTestId("preview-selection").textContent).toBe("No item selected");
    fireEvent.click(screen.getByRole("button", { name: "Preview drag" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("Uniform scale"), {
      target: { value: "1.5" }
    });
    expect((screen.getByLabelText("Uniform scale") as HTMLInputElement).value).toBe("1.5");

    fireEvent.click(screen.getByRole("button", { name: "MAIN" }));
    const defaultMainAnchor = playerMainAnchor(DEFAULT_PLAYER_APPEARANCE_CATALOG, "default");
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");
    expect(screen.queryByLabelText("Selected anchor")).toBeNull();
    expect(screen.getByText(/single player world\/map interaction point/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Main drag" }));
    expect(Number((screen.getByLabelText("Main X") as HTMLInputElement).value))
      .toBeCloseTo(-2);
    expect(Number((screen.getByLabelText("Main Y") as HTMLInputElement).value))
      .toBeCloseTo(defaultMainAnchor.y - 3);
    fireEvent.click(screen.getByRole("button", { name: "Reset Current Main" }));
    expect(Number((screen.getByLabelText("Main X") as HTMLInputElement).value)).toBe(0);
    expect(Number((screen.getByLabelText("Main Y") as HTMLInputElement).value)).toBe(defaultMainAnchor.y);
    fireEvent.click(screen.getByRole("button", { name: "Anchors" }));
    expect((screen.getByLabelText("Selected anchor") as HTMLSelectElement).value)
      .toBe("face");
    expect(within(screen.getByLabelText("Selected anchor"))
      .queryByRole("option", { name: /MAIN/u })).toBeNull();
    fireEvent.change(screen.getByLabelText("Selected anchor"), {
      target: { value: "face" }
    });
    const anchorX = Number((screen.getByLabelText("Anchor X") as HTMLInputElement).value);
    const anchorY = Number((screen.getByLabelText("Anchor Y") as HTMLInputElement).value);
    fireEvent.click(screen.getByRole("button", { name: "Anchor drag" }));
    expect(Number((screen.getByLabelText("Anchor X") as HTMLInputElement).value))
      .toBeCloseTo(anchorX + 2);
    expect(Number((screen.getByLabelText("Anchor Y") as HTMLInputElement).value))
      .toBeCloseTo(anchorY + 3);

    fireEvent.change(screen.getByLabelText("Selected anchor"), {
      target: { value: "right_hand" }
    });
    fireEvent.change(screen.getByLabelText("Anchor X"), {
      target: { value: "-" }
    });
    expect((screen.getByLabelText("Anchor X") as HTMLInputElement).value).toBe("-");
    fireEvent.change(screen.getByLabelText("Anchor X"), {
      target: { value: "-27" }
    });
    expect((screen.getByLabelText("Anchor X") as HTMLInputElement).value).toBe("-27");
    fireEvent.change(screen.getByLabelText("Selected anchor"), {
      target: { value: "left_hand" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Mirror from Right hand" }));
    expect((screen.getByLabelText("Anchor X") as HTMLInputElement).value).toBe("27");

    fireEvent.click(screen.getByRole("button", { name: "Item" }));
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");

    fireEvent.click(screen.getByRole("button", { name: "Gem" }));
    expect(screen.getAllByRole("option", {
      name: /Diamond|Onyx|Opal|Amethyst|Topaz|Sapphire|Ruby|Emerald/u
    })).toHaveLength(8);
    fireEvent.change(screen.getByLabelText("Gem preview"), {
      target: { value: "topaz" }
    });
    expect(screen.getByTestId("preview-enhancement").textContent)
      .toContain('"gemstone":"topaz"');
    fireEvent.click(screen.getByRole("button", { name: "Gem drag" }));
    expect((screen.getByLabelText("Socket X") as HTMLInputElement).value).toBe("0.2");
    expect((screen.getByLabelText("Socket Y") as HTMLInputElement).value).toBe("0.65");
    fireEvent.change(screen.getByLabelText("Universal gem size (player px)"), {
      target: { value: "4" }
    });
    expect((screen.getByLabelText("Universal gem size (player px)") as HTMLInputElement).value)
      .toBe("4");

    fireEvent.click(screen.getByRole("button", { name: "Item" }));
    fireEvent.change(screen.getByLabelText("Core hue preview"), {
      target: { value: "venomsteel" }
    });
    expect(screen.getByTestId("preview-enhancement").textContent)
      .toContain('"coreId":"venomsteel"');
    expect(screen.getByTestId("preview-gem-visible").textContent).toBe("false");
    fireEvent.click(screen.getByLabelText("Gem overlay"));
    expect(screen.getByTestId("preview-gem-visible").textContent).toBe("true");
    fireEvent.click(screen.getByLabelText("Gem overlay"));
    expect(screen.getByTestId("preview-gem-visible").textContent).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: "Core Hues" }));
    expect(screen.getByRole("heading", { name: "Universal Core Hues" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("venomsteel hue"), {
      target: { value: "#44aa66" }
    });
    expect((screen.getByLabelText("venomsteel hue") as HTMLInputElement).value).toBe("#44aa66");
  });

  it("shows only the six gemstones supported by contract-16 workspaces", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 16 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "Gem" }));
    expect(screen.getAllByRole("option", {
      name: /Diamond|Opal|Amethyst|Sapphire|Ruby|Emerald/u
    })).toHaveLength(6);
    expect(screen.queryByRole("option", { name: "Onyx" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Topaz" })).toBeNull();
  });

  it("does not expose or write Main for pre-contract-33 worktrees", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 32 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.click(screen.getByRole("button", { name: "Anchors" }));
    expect(screen.queryByRole("button", { name: "MAIN" })).toBeNull();
    const selection = screen.getByLabelText("Selected anchor") as HTMLSelectElement;
    expect(selection.value).toBe("face");
    expect(within(selection).queryByRole("option", { name: /MAIN/u })).toBeNull();
  });

  it("edits and saves the player MAIN touch box without publishing appearance catalogs", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 34 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "MAIN" }));
    expect((await screen.findByLabelText("Hit shape") as HTMLSelectElement).value)
      .toBe("circle");
    fireEvent.click(screen.getByRole("button", { name: "Touch box drag" }));
    await vi.waitFor(() => {
      expect((screen.getByLabelText("Hit center X") as HTMLInputElement).value).toBe("0.2");
      expect((screen.getByLabelText("Hit center Y") as HTMLInputElement).value).toBe("0.3");
    });
    fireEvent.change(screen.getByLabelText("Hit shape"), {
      target: { value: "rectangle" }
    });
    fireEvent.change(screen.getByLabelText("Hit width (frame)"), {
      target: { value: "0.75" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save to Worktree" }));

    await vi.waitFor(() => {
      const runtimePublish = vi.mocked(globalThis.fetch).mock.calls.find(([request]) =>
        String(request) === "/api/runtime-assets/publish"
      );
      expect(runtimePublish).toBeDefined();
      const body = JSON.parse(String(runtimePublish?.[1]?.body)) as {
        presentation: typeof RUNTIME_PNG_PRESENTATION_CATALOG;
      };
      expect(body.presentation.sprites.player.hitGeometry).toMatchObject({
        shape: "rectangle",
        centerX: 0.2,
        centerY: 0.3,
        width: 0.75
      });
      expect(vi.mocked(globalThis.fetch).mock.calls.some(([request]) =>
        String(request) === "/api/publish"
      )).toBe(false);
    });
  });

  it("reverts only the player touch box while preserving unrelated Game PNG edits", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 34 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "Game PNGs" }));
    const height = await screen.findByLabelText("Height (px)") as HTMLInputElement;
    fireEvent.change(height, { target: { value: "91" } });
    expect(height.value).toBe("91");

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "MAIN" }));
    fireEvent.change(await screen.findByLabelText("Hit center X"), {
      target: { value: "0.2" }
    });
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Revert" })).toHaveProperty("disabled", false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await vi.waitFor(() => {
      expect((screen.getByLabelText("Hit center X") as HTMLInputElement).value).toBe("0.5");
    });

    fireEvent.click(screen.getByRole("button", { name: "Game PNGs" }));
    expect((await screen.findByLabelText("Height (px)") as HTMLInputElement).value)
      .toBe("91");
    expect(screen.getByRole("button", { name: "Save to Worktree" }))
      .toHaveProperty("disabled", false);
  });

  it("hides enhancement authoring for pre-contract-16 worktrees", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 15 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    expect(screen.queryByRole("button", { name: "Gem" })).toBeNull();
    expect(screen.queryByLabelText("Gem overlay")).toBeNull();
    expect(screen.queryByLabelText("Gem preview")).toBeNull();
    expect(screen.queryByLabelText("Core hue preview")).toBeNull();
    const hues = screen.getByRole("tab", { name: "Core Hues" }) as HTMLButtonElement;
    expect(hues.disabled).toBe(true);
    expect(hues.title).toMatch(/1\.16/u);
  });

  it("limits gem sockets to mechanically enhanceable weapons and armor", () => {
    const catalog = studioCatalog();
    const sword = catalog.appearances.find(({ appearanceId }) =>
      appearanceId === "studio_sword"
    )!;
    const armor = catalog.appearances.find(({ appearanceId }) =>
      appearanceId === "padded_tunic"
    )!;
    const backItem = {
      appearanceId: "back_test",
      displayName: "Back Test",
      familyId: "back_item",
      assetKey: "cosmetics/back-test.png",
      cosmetic: true,
      placements: {}
    };
    catalog.appearances.push(backItem);

    expect(appearanceSupportsGem(catalog, sword)).toBe(true);
    expect(appearanceSupportsGem(catalog, armor)).toBe(true);
    expect(appearanceSupportsGem(catalog, backItem)).toBe(false);
  });

  it("disables master scale when the worktree lacks renderer contract 5", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 4 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    const masterScale = screen.getByRole("button", {
      name: "Master Scale"
    }) as HTMLButtonElement;
    expect(masterScale.disabled).toBe(true);
    expect(masterScale.title).toMatch(/contract 5/u);
  });

  it("keeps boss master size guarded in pre-contract-9 content batches", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 8 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.click(screen.getByRole("tab", { name: "Bosses" }));
    const masterSize = screen.getByRole("button", {
      name: "Master Size"
    }) as HTMLButtonElement;
    expect(masterSize.disabled).toBe(true);
    expect(masterSize.title).toMatch(/contract 9/u);
  });

  it("requires an app update before requesting incompatible workspace content", async () => {
    mockStudioFetch({
      writesAllowed: false,
      remoteRevision: 1,
      contractVersion: 14,
      compatible: false
    });
    render(<App />);
    expect(await screen.findByText("Appearance Studio update required")).toBeTruthy();
    expect(screen.getByText(/requires Appearance Studio 2\.0\.0 or newer/u)).toBeTruthy();
    expect(screen.getByText(/catalog was not opened or changed/u)).toBeTruthy();
    const requests = vi.mocked(globalThis.fetch).mock.calls.map(([request]) => String(request));
    expect(requests).toContain("/api/session");
    expect(requests).not.toContain("/api/catalog");
    expect(requests).not.toContain("/api/item-variants");
  });

  it("selects and edits precise placement with drag, nudges, transform controls, layers, and undo", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    expect(screen.getByLabelText("Studio worktree identity").textContent)
      .toContain("worktree");
    expect(screen.getByLabelText("Studio worktree identity").textContent)
      .toContain("feature/studio");
    expect(document.title).toContain("worktree");
    expect(document.title).toContain("feature/studio");
    const offsetX = screen.getByLabelText("Offset X") as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Preview drag" }));
    expect(offsetX.value).toBe("3");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(offsetX.value).toBe("4");
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
    expect((screen.getByLabelText("Offset Y") as HTMLInputElement).value).toBe("4");
    fireEvent.change(screen.getByLabelText("Rotation°"), { target: { value: "12.5" } });
    fireEvent.change(screen.getByLabelText("Scale X"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Pivot Y"), { target: { value: "0.9" } });
    expect((screen.getByLabelText("Fixed render layer") as HTMLInputElement).value)
      .toBe("front_hand");
    expect((screen.getByLabelText("Fixed render layer") as HTMLInputElement).readOnly)
      .toBe(true);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText("Pivot Y") as HTMLInputElement).value).not.toBe("0.9");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect((screen.getByLabelText("Pivot Y") as HTMLInputElement).value).toBe("0.9");
  });

  it("switches explicitly between new-variant and existing-item workflows", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    expect(screen.queryByText("Male")).toBeNull();
    expect(screen.queryByText("Female")).toBeNull();
    expect(screen.queryByRole("button", { name: "Local" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remote" })).toBeNull();
    const importTarget = screen.getByLabelText("Import target");
    expect(within(importTarget).getByRole("option", { name: "Base Body / Player Base" })).toBeTruthy();
    expect(within(importTarget).getByRole("option", { name: "Skin-tone variant" })).toBeTruthy();
    expect(within(importTarget).queryByRole("option", { name: /Head/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Base Body" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Head" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create New Variant" }));
    expect(screen.getByLabelText("Mechanical family")).toBeTruthy();
    expect(screen.getByLabelText("New item ID")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Existing" }));
    expect(screen.getByLabelText("Existing item")).toBeTruthy();
  });

  it("creates the first stock Chainmail appearance from the enabled empty drop zone", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.click(screen.getByRole("button", { name: "Body Armor" }));
    fireEvent.change(screen.getByLabelText("Armor type"), {
      target: { value: "chest_chain_mail" }
    });

    const dropZone = screen.getByRole("button", {
      name: /No artwork exists yet for Chainmail Armor; dropping or choosing a PNG creates the first appearance/u
    });
    expect(dropZone.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByText(/No artwork exists yet for Chainmail Armor.*create its first appearance/u))
      .toBeTruthy();
    const fileInput = dropZone.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(fileInput, "click").mockImplementation(() => undefined);
    fireEvent.click(dropZone);
    expect(click).toHaveBeenCalledOnce();

    const file = new File([new Uint8Array([1, 2, 3])], "chainmail.png", {
      type: "image/png"
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(await screen.findByText(/Staged .* for chain_armor/u)).toBeTruthy();
    expect(screen.getByTestId("preview-selection").textContent).toBe("chain_armor");
  });

  it("navigates permanent categories, weapon types, style variants, and paired sides", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    for (const category of [
      "Body Armor",
      "Gloves",
      "Boots",
      "Weapons",
      "Shields"
    ]) {
      expect(screen.getByRole("button", { name: category })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    fireEvent.click(screen.getByRole("button", { name: "Hair" }));
    fireEvent.click(screen.getByRole("button", { name: "Create New Variant" }));
    const appearanceId = screen.getByLabelText("New appearance ID") as HTMLInputElement;
    fireEvent.change(appearanceId, { target: { value: "Hair 1" } });
    expect(appearanceId.value).toBe("hair-1");
    expect(screen.getByText("IDs are formatted automatically; for example, Hair 1 becomes hair-1."))
      .toBeTruthy();
    expect(screen.queryByLabelText("Mechanical family")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Gear" }));
    fireEvent.click(screen.getByRole("button", { name: "Weapons" }));
    fireEvent.change(screen.getByLabelText("Weapon type"), { target: { value: "staff" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Existing" }));
    expect(screen.getByRole("option", { name: "Staff · melee" })).toBeTruthy();
    expect(screen.getByTestId("preview-selection").textContent).toBe("starter-staff");

    fireEvent.click(screen.getByRole("button", { name: "Body Armor" }));
    expect(screen.getByLabelText("Armor type")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Tunic/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Breastplate/u })).toBeNull();
    fireEvent.change(screen.getByLabelText("Armor type"), {
      target: { value: "chest_breastplate" }
    });
    expect(screen.getByRole("button", { name: /^Breastplate/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Tunic/u })).toBeNull();
    expect(screen.queryByRole("option", { name: "Training Heavy Chest · chest" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Gloves" }));
    expect(screen.getByRole("button", { name: "Right" }).className).toContain("active");
    expect(screen.getByRole("button", { name: "Left" })).toBeTruthy();
    expect(screen.getByText(/Upload one right-side PNG.*Left starts mirrored/u)).toBeTruthy();
  });

  it.each([
    {
      category: "Gloves",
      itemId: "paired_gloves",
      displayName: "Paired Gloves",
      assetKey: "armor/gloves/paired-test.png",
      rightAnchor: "right_hand",
      leftAnchor: "left_hand"
    },
    {
      category: "Boots",
      itemId: "paired_boots",
      displayName: "Paired Boots",
      assetKey: "armor/boots/paired-test.png",
      rightAnchor: "right_foot",
      leftAnchor: "left_foot"
    }
  ])("authors independent mirrored $category sides from one uploaded PNG", async ({
    category,
    itemId,
    displayName,
    assetKey,
    rightAnchor,
    leftAnchor
  }) => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.click(screen.getByRole("button", { name: category }));
    fireEvent.click(screen.getByRole("button", { name: "Create New Variant" }));
    fireEvent.change(screen.getByLabelText("New item ID"), { target: { value: itemId } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: displayName } });
    const dropZone = screen.getByRole("button", {
      name: `Choose one right-side PNG for new ${category} variant`
    });
    const fileInput = dropZone.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], `${itemId}.png`, {
      type: "image/png"
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByDisplayValue(assetKey)).toBeTruthy();
    expect((screen.getByLabelText("Anchor") as HTMLSelectElement).value).toBe(rightAnchor);
    expect((screen.getByLabelText("Scale X") as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("Offset X"), { target: { value: "7" } });

    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    expect((screen.getByDisplayValue(assetKey) as HTMLInputElement).value).toBe(assetKey);
    expect((screen.getByLabelText("Anchor") as HTMLSelectElement).value).toBe(leftAnchor);
    expect((screen.getByLabelText("Scale X") as HTMLInputElement).value).toBe("-1");
    fireEvent.change(screen.getByLabelText("Offset X"), { target: { value: "13" } });

    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("13");
  });

  it("restores the selected variant when returning to a category", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    fireEvent.click(screen.getByRole("button", { name: "Hair" }));
    fireEvent.click(screen.getByRole("button", { name: /^Hair Test/u }));
    expect(screen.getByTestId("preview-selection").textContent).toBe("hair_test");
    fireEvent.click(screen.getByRole("tab", { name: "Gear" }));
    fireEvent.click(screen.getByRole("button", { name: "Weapons" }));
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");
    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    fireEvent.click(screen.getByRole("button", { name: "Hair" }));
    expect(screen.getByTestId("preview-selection").textContent).toBe("hair_test");
  });

  it("recovers an unsaved draft after the editor remounts", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.change(screen.getByLabelText("Offset X"), {
      target: { value: "17" }
    });
    fireEvent.click(screen.getByRole("tab", { name: "Core Hues" }));
    fireEvent.change(screen.getByLabelText("venomsteel hue"), {
      target: { value: "#44aa66" }
    });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    cleanup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Universal Core Hues" })).toBeTruthy();
    expect((screen.getByLabelText("venomsteel hue") as HTMLInputElement).value)
      .toBe("#44aa66");
    fireEvent.click(screen.getByRole("tab", { name: "Player" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("17");
    expect(await screen.findByText(/Recovered unsaved changes from/u)).toBeTruthy();
  });

  it("keeps edits dirty and visible when saving fails", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, publishStatus: 409 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.change(screen.getByLabelText("Offset X"), {
      target: { value: "19" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save to Worktree" }));

    expect(await screen.findByText("Save failed — changes retained")).toBeTruthy();
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("19");
  });

  it("uses explicit preview-only overlays without changing the selected variant", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "Preview Overlays (0)" }));
    expect(screen.getByText(/PREVIEW ONLY.*never attached/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Overlay appearance"), {
      target: { value: "hair_test" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Overlay" }));
    expect(screen.getByTestId("preview-overlays").textContent).toBe("hair_test");
    expect(screen.getByText(/PREVIEW OVERLAY.*NOT SAVED/u)).toBeTruthy();
    expect(screen.getByTestId("preview-selection").textContent).toBe("studio_sword");
  });

  it("requires confirmation before deleting a never-published draft variant", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    fireEvent.click(screen.getByRole("button", { name: "Hair" }));
    fireEvent.click(screen.getByRole("button", { name: /^Hair Test/u }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Variant" }));
    expect(screen.getByRole("button", { name: /^Hair Test Copy/u })).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete Variant" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage deletion" }));
    expect(screen.queryByRole("button", { name: /^Hair Test Copy/u })).toBeNull();
    expect(screen.getByText(/Staged deletion of Hair Test Copy/u)).toBeTruthy();
    const newAppearanceId = screen.getByLabelText("New appearance ID") as HTMLInputElement;
    expect(document.activeElement).toBe(newAppearanceId);
    fireEvent.change(newAppearanceId, { target: { value: "Hair Replacement" } });
    expect(newAppearanceId.value).toBe("hair-replacement");
  });

  it("removes and restores a saved standalone style variant", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    expect(screen.getByRole("button", { name: "Remove Appearance" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    fireEvent.click(screen.getByRole("button", { name: "Hair" }));
    fireEvent.click(screen.getByRole("button", { name: /^Hair Test/u }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Appearance" }));
    expect(screen.getByRole("button", { name: /^Hair Test/u })).toBeTruthy();
    expect(screen.getByRole("alertdialog", { name: "Remove Hair Test?" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stage removal" }));
    expect(screen.queryByRole("button", { name: /^Hair Test/u })).toBeNull();
    expect(screen.getByText(/Staged removal of Hair Test/u)).toBeTruthy();
    await vi.waitFor(() => {
      const draft = JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!)!) as {
        catalog: PlayerAppearanceCatalog;
      };
      expect(draft.catalog.appearances.find(({ appearanceId }) =>
        appearanceId === "hair_test"
      )).toMatchObject({ retired: true, salon: { state: "retired" } });
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Show removed appearances" }));
    const retiredVariant = screen.getByRole("button", { name: /^Hair Test/u });
    expect(retiredVariant.textContent).toContain("removed");
    fireEvent.click(retiredVariant);
    fireEvent.click(screen.getByRole("button", { name: "Restore Appearance" }));
    expect(screen.getByRole("button", { name: /^Hair Test/u }).textContent)
      .not.toContain("removed");
    fireEvent.change(screen.getByLabelText("Offset X"), { target: { value: "1" } });
    await vi.waitFor(() => {
      const draft = JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!)!) as {
        catalog: PlayerAppearanceCatalog;
      };
      expect(draft.catalog.appearances.find(({ appearanceId }) =>
        appearanceId === "hair_test"
      )).toMatchObject({ salon: { state: "selectable" } });
      expect(draft.catalog.appearances.find(({ appearanceId }) =>
        appearanceId === "hair_test"
      )?.retired).toBeUndefined();
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Show removed appearances" }));
    expect(screen.getByRole("button", { name: /^Hair Test/u })).toBeTruthy();
    expect(screen.getByText("Restored Hair Test to active appearance menus.")).toBeTruthy();
  });

  it.each([
    { category: "Weapons", appearance: /^Studio Sword/u, definition: /^Sword · melee/u },
    { category: "Body Armor", appearance: /^Tunic/u, definition: /^Tunic · chest/u }
  ])("removes and restores saved stock gear in $category", async ({
    category,
    appearance,
    definition
  }) => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.click(screen.getByRole("button", { name: category }));
    fireEvent.click(screen.getByRole("button", { name: appearance }));

    fireEvent.click(screen.getByRole("button", { name: "Remove Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage removal" }));
    expect(screen.queryByRole("button", { name: appearance })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Existing" }));
    expect(screen.queryByRole("option", { name: definition })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show removed appearances" }));
    expect(screen.getByRole("option", { name: definition })).toBeTruthy();
    const removedAppearance = screen.getByRole("button", { name: appearance });
    expect(removedAppearance.textContent).toContain("removed");
    fireEvent.click(removedAppearance);
    fireEvent.click(screen.getByRole("button", { name: "Restore Appearance" }));
    expect(screen.getByRole("option", { name: definition })).toBeTruthy();
  });

  it("retires and restores the linked item variant with a saved appearance", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.click(screen.getByRole("button", { name: "Body Armor" }));
    fireEvent.change(screen.getByLabelText("Armor type"), {
      target: { value: "chest_breastplate" }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Breastplate/u }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage removal" }));

    await vi.waitFor(() => {
      const draft = JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!)!) as {
        catalog: PlayerAppearanceCatalog;
        itemVariants: typeof ITEM_VARIANT_CATALOG;
      };
      expect(draft.catalog.appearances.find(({ appearanceId }) =>
        appearanceId === "breast_plate"
      )?.retired).toBe(true);
      expect(draft.itemVariants.variants.find(({ definitionId }) =>
        definitionId === "breast_plate"
      )?.retired).toBe(true);
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Show removed appearances" }));
    fireEvent.click(screen.getByRole("button", { name: /^Breastplate/u }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Appearance" }));
    await vi.waitFor(() => {
      const draft = JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!)!) as {
        catalog: PlayerAppearanceCatalog;
        itemVariants: typeof ITEM_VARIANT_CATALOG;
      };
      expect(draft.catalog.appearances.find(({ appearanceId }) =>
        appearanceId === "breast_plate"
      )?.retired).toBeUndefined();
      expect(draft.itemVariants.variants.find(({ definitionId }) =>
        definitionId === "breast_plate"
      )?.retired).toBeUndefined();
    });
  });

  it("returns an already-retired published variant to active item choices after restoration", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    fireEvent.change(screen.getByLabelText("Weapon type"), {
      target: { value: "staff" }
    });
    expect(screen.queryByRole("button", { name: /^Hammer/u })).toBeNull();
    expect(screen.queryByRole("option", { name: /^Hammer · melee/u })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show removed appearances" }));
    fireEvent.click(screen.getByRole("button", { name: /^Hammer/u }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Appearance" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show removed appearances" }));

    expect(screen.getByRole("button", { name: /^Hammer/u }).textContent)
      .not.toContain("removed");
    expect(screen.getByRole("option", { name: /^Hammer · melee/u })).toBeTruthy();
  });

  it("replaces the PNG on an existing variant without changing its placement", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("tab", { name: "Player Overlays" }));
    fireEvent.click(screen.getByRole("button", { name: "Hair" }));
    fireEvent.click(screen.getByRole("button", { name: /^Hair Test/u }));
    expect(screen.getByRole("button", { name: "Replace PNG for Hair Test" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace Current PNG" }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const replacement = new File([new Uint8Array([1, 2, 3])], "hair-test.png", {
      type: "image/png"
    });
    Object.defineProperty(replacement, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer
    });
    fireEvent.change(fileInput, { target: { files: [replacement] } });

    expect(await screen.findByDisplayValue("hair/hair-test-replaced.png")).toBeTruthy();
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("0");
  });

  it("shows the native content-batch workflow only in the desktop app", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, desktop: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Publish…" }));
    expect(await screen.findByRole("button", { name: "Start Separate Batch" }))
      .toBeTruthy();
    expect(screen.getByText("FEATURE BRANCH — NOT AUTOMATICALLY LIVE")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit & Push Branch — Not Live" }))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Integrate This Batch into Test" }))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish t399 to Public Server" }))
      .toBeTruthy();
  });

  it("shows protected-worktree and server-drift warnings and disables saving", async () => {
    mockStudioFetch({ writesAllowed: false, remoteRevision: 99 });
    render(<App />);
    expect(await screen.findByText("Read-only workspace.")).toBeTruthy();
    expect(screen.getByText("Server content mismatch.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save to Worktree" });
    expect(save).toHaveProperty("disabled", true);
    expect(save.getAttribute("title")).toMatch(/^Cannot save:/u);
    expect(screen.getByTestId("studio-status-bar").textContent).toContain("Read-only workspace");
  });

  it("keeps Selected server collapsed until the author opens it", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    const toggle = await screen.findByTestId("studio-server");
    expect(screen.queryByText("Selected server")).toBeNull();
    expect(screen.queryByLabelText("Ash Atlas server URL")).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText("Selected server")).toBeTruthy();
    expect(screen.getByLabelText("Ash Atlas server URL")).toBeTruthy();
    fireEvent.click(screen.getByTestId("studio-drawer-close"));
    expect(screen.queryByTestId("studio-drawer")).toBeNull();
  });

  it("uses Idle as the locked source frame until a pose is changed or reset", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.change(screen.getByLabelText("Offset X"), {
      target: { value: "14" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("14");
    expect(screen.getByLabelText("Ready follows Idle")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Offset X"), {
      target: { value: "22" }
    });
    expect(screen.getByLabelText("Ready has a local override")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Idle" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("14");

    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("22");
    fireEvent.click(screen.getByRole("button", { name: "Reset Ready to Idle" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("14");
    expect(screen.getByLabelText("Ready follows Idle")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Action" }));
    expect((screen.getByLabelText("Offset X") as HTMLInputElement).value).toBe("14");
    expect(screen.getByLabelText("Action follows Idle")).toBeTruthy();
  });

  it("keeps projectile authoring guarded in pre-contract-10 content batches", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1, contractVersion: 9 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");
    const rangedVisual = screen.getByRole("checkbox", {
      name: "Ranged visual (projectile on hit)"
    }) as HTMLInputElement;
    expect(rangedVisual.disabled).toBe(true);
    expect(rangedVisual.closest("label")?.title).toMatch(/contract 10/u);
  });

  it("authors and removes a visual-only projectile for weapon appearances", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    const rangedVisual = screen.getByRole("checkbox", {
      name: "Ranged visual (projectile on hit)"
    });
    fireEvent.click(rangedVisual);
    const dropZone = screen.getByRole("button", {
      name: "Add projectile PNG for Studio Sword"
    });
    const fileInput = dropZone.querySelector<HTMLInputElement>('input[type="file"]')!;
    const projectile = new File([new Uint8Array([1, 2, 3])], "ember-arrow.png", {
      type: "image/png"
    });
    Object.defineProperty(projectile, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer
    });
    fireEvent.change(fileInput, { target: { files: [projectile] } });

    expect(await screen.findByText("projectiles/ember-arrow.png")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Replace projectile PNG for Studio Sword"
    })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Projectile" }));
    expect((screen.getByRole("checkbox", {
      name: "Target character overlay"
    }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Scale X"), { target: { value: "0.35" } });
    fireEvent.change(screen.getByLabelText("Impact X"), { target: { value: "0.9" } });
    fireEvent.change(screen.getByLabelText("Tail X"), { target: { value: "0.1" } });
    expect((screen.getByLabelText("Scale X") as HTMLInputElement).value).toBe("0.35");
    expect((screen.getByLabelText("Impact X") as HTMLInputElement).value).toBe("0.9");
    expect((screen.getByLabelText("Tail X") as HTMLInputElement).value).toBe("0.1");
    fireEvent.click(screen.getByRole("button", { name: "Impact Point" }));
    expect(screen.getByText(/Point placement locks the PNG in place/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Item" }));
    fireEvent.click(screen.getByRole("checkbox", {
      name: "Ranged visual (projectile on hit)"
    }));
    expect(screen.queryByText("projectiles/ember-arrow.png")).toBeNull();
  });

  it("keeps official bosses in a separate workspace with a pose-driven weapon slot", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    expect(screen.queryByText("Xoral")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Bosses" }));

    expect(screen.getAllByText("Designated bosses")).toHaveLength(2);
    expect(screen.getAllByText("The Xoral")[0]?.closest("button")).toBeTruthy();
    expect(screen.getByText("Weapon slot empty")).toBeTruthy();
    expect(screen.getByTestId("boss-preview").textContent).toBe("xoral:idle");
    fireEvent.click(screen.getByRole("button", { name: "Weapon Pivot" }));
    fireEvent.click(screen.getByRole("button", { name: "Boss pivot drag" }));
    expect((screen.getByLabelText("Pivot X") as HTMLInputElement).value).toBe("0.3");
    expect((screen.getByLabelText("Pivot Y") as HTMLInputElement).value).toBe("0.4");
    fireEvent.click(screen.getByRole("button", { name: "Master Size" }));
    fireEvent.change(screen.getByLabelText("Boss master size"), {
      target: { value: "1.5" }
    });
    expect((screen.getByLabelText("Boss master size") as HTMLInputElement).value).toBe("1.5");
    fireEvent.click(screen.getByRole("button", { name: "Weapon" }));
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect(screen.getByTestId("boss-preview").textContent).toBe("xoral:combat_ready");
    fireEvent.change(screen.getByLabelText("Offset X"), { target: { value: "12" } });
    expect(screen.getByLabelText("Ready has a boss weapon override")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Action" }));
    expect(screen.getByTestId("boss-preview").textContent).toBe("xoral:attack_action");

    fireEvent.click(screen.getByRole("tab", { name: "Player" }));
    expect(await screen.findByDisplayValue("Studio Sword")).toBeTruthy();
    expect(screen.queryByText("Weapon slot empty")).toBeNull();
  });

  it("edits the production size of a game PNG in the Asset Studio playground", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "Game PNGs" }));
    expect(await screen.findByRole("heading", { name: "Game PNG Library" })).toBeTruthy();
    expect(screen.getAllByText("Deer").length).toBeGreaterThan(0);
    const comparisonToggle = screen.getByRole("checkbox", { name: "Comparison overlay" }) as HTMLInputElement;
    const overlayPicker = screen.getByLabelText("Overlay any game PNG for size comparison");
    fireEvent.click(comparisonToggle);
    expect(comparisonToggle.checked).toBe(false);
    fireEvent.change(overlayPicker, {
      target: { value: "apps/client/src/assets/deer.png" }
    });
    expect(comparisonToggle.checked).toBe(true);
    const comparisonOverlay = screen.getByAltText("Deer comparison overlay");
    expect(comparisonOverlay.closest(".asset-target-frame")).toBeTruthy();
    expect(screen.getByText(/Drag it to compare placement/u)).toBeTruthy();
    Object.defineProperties(comparisonOverlay, {
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() }
    });
    const primaryPointerEvent = (
      type: "pointerdown" | "pointermove",
      pointerId: number,
      clientX: number,
      clientY: number
    ): MouseEvent => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY
      });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        isPrimary: { value: true }
      });
      return event;
    };
    fireEvent(comparisonOverlay, primaryPointerEvent("pointerdown", 7, 100, 100));
    fireEvent(comparisonOverlay, primaryPointerEvent("pointermove", 7, 124, 112));
    expect((comparisonOverlay as HTMLImageElement).style.transform).toContain("24px), 12px");
    const resetOverlay = screen.getByRole("button", { name: "Reset position" });
    expect(resetOverlay).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Save to Worktree" }))
      .toHaveProperty("disabled", true);
    fireEvent.click(resetOverlay);
    expect((comparisonOverlay as HTMLImageElement).style.transform).toContain("0px), 0px");
    expect(resetOverlay).toHaveProperty("disabled", true);
    fireEvent(comparisonOverlay, primaryPointerEvent("pointerdown", 8, 100, 100));
    fireEvent(comparisonOverlay, primaryPointerEvent("pointermove", 8, 112, 106));
    fireEvent.change(overlayPicker, { target: { value: "" } });
    fireEvent.change(overlayPicker, {
      target: { value: "apps/client/src/assets/deer.png" }
    });
    expect((screen.getByAltText("Deer comparison overlay") as HTMLImageElement).style.transform)
      .toContain("0px), 0px");
    const geometryGuidance = document.querySelector(".asset-geometry-guidance");
    expect(geometryGuidance?.textContent).toContain(
      "Cyan anchor: the point on the PNG attached to the object's map position"
    );
    expect(geometryGuidance?.textContent).toContain(
      "Gold hit/clickable area: where click/tap selects the object"
    );
    expect((screen.getByLabelText("Hit shape") as HTMLSelectElement).value).toBe("rectangle");
    expect(screen.queryByLabelText("Minimum height")).toBeNull();
    expect(screen.queryByLabelText("Maximum height")).toBeNull();
    expect(screen.queryByLabelText("Zoom strength")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Keep standardized" }) as HTMLInputElement).checked)
      .toBe(false);
    expect(screen.getByLabelText("World object zoom policy").textContent)
      .toContain("Shared zoom: 5% growth per +0.1 zoom; 25% minimum floor; no upper cap.");
    fireEvent.change(screen.getByLabelText("Hit shape"), { target: { value: "circle" } });
    expect(screen.getByLabelText("Hit radius (px)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Hit shape"), { target: { value: "rectangle" } });
    expect(screen.getByLabelText("Width (px)")).toBeTruthy();
    expect((screen.getByLabelText("Lock proportions") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Height (px)"), {
      target: { value: "88" }
    });
    fireEvent.change(screen.getByLabelText("Hit center X"), {
      target: { value: "0.42" }
    });
    fireEvent.change(screen.getByLabelText("Hit width (frame)"), {
      target: { value: "0.73" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save to Worktree" }));

    await vi.waitFor(() => {
      const publish = vi.mocked(globalThis.fetch).mock.calls.find(([request]) =>
        String(request) === "/api/runtime-assets/publish"
      );
      expect(publish).toBeDefined();
      const body = JSON.parse(String(publish?.[1]?.body)) as {
        presentation: typeof RUNTIME_PNG_PRESENTATION_CATALOG;
      };
      expect(body.presentation.sprites.deer?.hitGeometry).toMatchObject({
        shape: "rectangle",
        centerX: 0.42,
        width: 0.73
      });
      expect(body.presentation.sprites.deer?.baseHeightPx).toBe(88);
      expect(body.presentation.sprites.deer?.minHeightPx).toBeCloseTo(22);
      expect(body.presentation.sprites.deer?.maxHeightPx).toBeNull();
      expect(body.presentation.sprites.deer?.zoomStrength).toBe(0.70389327891398);
    });
  });

  it("edits final standardized dimensions without rewriting the master scale", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "Game PNGs" }));
    expect(await screen.findByRole("heading", { name: "Game PNG Library" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("World PNG Master Scale value"), {
      target: { value: "1.2" }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep standardized" }));
    expect(screen.queryByLabelText("Height (px)")).toBeNull();
    const finalHeight = screen.getByLabelText("Height (final px)") as HTMLInputElement;
    expect(finalHeight.value).toBe("83.4");
    expect(finalHeight.min).toBe("1.2");
    fireEvent.change(finalHeight, {
      target: { value: "60" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save to Worktree" }));

    await vi.waitFor(() => {
      const publish = vi.mocked(globalThis.fetch).mock.calls.find(([request]) =>
        String(request) === "/api/runtime-assets/publish"
      );
      expect(publish).toBeDefined();
      const body = JSON.parse(String(publish?.[1]?.body)) as {
        presentation: typeof RUNTIME_PNG_PRESENTATION_CATALOG;
      };
      expect(body.presentation.masterScale).toBe(1.2);
      expect(body.presentation.sprites.deer?.baseHeightPx).toBe(50);
      expect(body.presentation.sprites.deer?.minHeightPx).toBe(12.5);
    });
  });

  it("opens Interior Studio and routes its dirty draft through the shared header save", async () => {
    mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
    render(<App />);
    await screen.findByDisplayValue("Studio Sword");

    fireEvent.click(screen.getByRole("button", { name: "Interiors" }));
    expect(await screen.findByRole("heading", { name: "Things to Add" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Room" }));
    fireEvent.change(within(screen.getByRole("region", { name: "Create room" })).getByLabelText("Room name"), { target: { value: "Draft Room" } });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));
    expect(screen.getAllByDisplayValue("Draft Room").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save to Worktree" }));

    await vi.waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([request]) =>
      /^\/api\/interior-catalog\/[^/]+\/publish$/u.test(String(request))
    )).toBe(true));
  });

  it("opens Interiors for a saved retired workspace id", async () => {
    for (const retired of ["dungeons", "manors", "greenhouses"]) {
      cleanup();
      window.sessionStorage.setItem("studio-workspace", retired);
      mockStudioFetch({ writesAllowed: true, remoteRevision: 1 });
      render(<App />);
      const interiors = await screen.findByRole("button", { name: "Interiors" });
      expect(interiors.getAttribute("aria-current")).toBe("page");
      expect(screen.queryByRole("button", { name: /legacy/u })).toBeNull();
      vi.restoreAllMocks();
    }
  });
});

function mockStudioFetch(input: {
  writesAllowed: boolean;
  remoteRevision: number;
  desktop?: boolean;
  contractVersion?: number;
  compatible?: boolean;
  publishStatus?: number;
}): void {
  const catalog = studioCatalog();
  const contractVersion = input.contractVersion ?? 20;
  const compatible = input.compatible ?? true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = String(request);
    if (url === "/api/session") {
      return jsonResponse({
        csrfToken: "csrf",
        origin: "http://127.0.0.1:5285",
        workspace: {
          repositoryPath: "C:/repo",
          worktreePath: "C:/worktree",
          branch: input.writesAllowed ? "feature/studio" : "integration/test",
          commitSha: "a".repeat(40),
          writesAllowed: input.writesAllowed && compatible,
          writeBlockReason: compatible
            ? input.writesAllowed ? null : "Protected branch integration/test."
            : "Appearance Studio contract is not supported by this app.",
          catalogRevision: catalog.catalogRevision,
          isLinkedWorktree: true,
          compatibility: {
            contractVersion,
            supportedContractVersion: 20,
            minimumDesktopVersion: !compatible
              ? "2.0.0"
            : contractVersion >= 50 ? "1.50.0"
            : contractVersion >= 49 ? "1.49.0"
            : contractVersion >= 48 ? "1.48.0"
            : contractVersion >= 47 ? "1.47.0"
            : contractVersion >= 46 ? "1.46.0"
            : contractVersion >= 45 ? "1.45.0"
            : contractVersion >= 44 ? "1.44.0"
            : contractVersion >= 43 ? "1.43.0"
            : contractVersion >= 42 ? "1.42.0"
            : contractVersion >= 41 ? "1.41.0"
            : contractVersion >= 40 ? "1.40.0"
            : contractVersion >= 39 ? "1.39.0"
            : contractVersion >= 38 ? "1.38.0"
            : contractVersion >= 37 ? "1.37.0"
              : contractVersion >= 36 ? "1.36.0"
              : contractVersion >= 35 ? "1.35.0"
              : contractVersion >= 34 ? "1.34.0"
              : contractVersion >= 33 ? "1.33.0"
              : contractVersion >= 20 ? "1.20.0"
              : contractVersion >= 19 ? "1.19.0"
              : contractVersion >= 18 ? "1.18.0"
              : contractVersion >= 17 ? "1.17.0"
              : contractVersion >= 16 ? "1.16.0"
              : contractVersion >= 14 ? "1.14.0"
              : contractVersion >= 13 ? "1.13.0"
              : contractVersion >= 12 ? "1.12.0"
              : contractVersion >= 11 ? "1.11.0"
                : contractVersion >= 10 ? "1.10.0"
                : contractVersion >= 9 ? "1.9.0"
                : contractVersion >= 8 ? "1.8.0" : "1.3.0",
            compatible
          }
        },
        server: {
          pid: 1234,
          worktreePath: "C:/worktree",
          branch: input.writesAllowed ? "feature/studio" : "integration/test",
          commitSha: "a".repeat(40),
          port: 30123,
          startedAt: "2026-07-30T00:00:00.000Z"
        }
      });
    }
    if (url === "/api/catalog") return jsonResponse(catalog);
    if (url === "/api/boss-catalog") return jsonResponse(DEFAULT_BOSS_APPEARANCE_CATALOG);
    if (url === "/api/interior-catalog") {
      const interior = interiorCatalogFromLegacy();
      return jsonResponse({
        catalogRevision: interior.library.catalogRevision,
        library: interior.library,
        spaces: interior.spaces,
        spaceRevisions: Object.fromEntries(interior.spaces.map((space) => [space.id, space.revision]))
      });
    }
    if (url === "/api/item-variants") return jsonResponse(ITEM_VARIANT_CATALOG);
    if (url === "/api/runtime-assets") return jsonResponse({
      assets: [{
        id: "apps/client/src/assets/deer.png",
        label: "Deer",
        category: "Mobs & Animals",
        relativeFile: "apps/client/src/assets/deer.png",
        imageUrl: "/runtime-assets/apps/client/src/assets/deer.png",
        width: 100,
        height: 80,
        bytes: 400,
        contentHash: "e".repeat(64),
        usages: [{
          id: "production-0",
          label: "World Mob",
          context: "Production renderer",
          editor: { kind: "sprite", key: "deer" }
        }],
        staged: false
      }],
      presentation: RUNTIME_PNG_PRESENTATION_CATALOG
    });
    if (url === "/api/runtime-assets/inbox") return jsonResponse({
      sourceDirectory: "Documents/AtlasPNGS",
      entries: []
    });
    if (url === "/api/publish") {
      if (input.publishStatus && input.publishStatus !== 200) {
        return new Response(JSON.stringify({
          error: "Catalog changed in another Studio window",
          code: "CATALOG_REVISION_CONFLICT"
        }), {
          status: input.publishStatus,
          headers: { "content-type": "application/json" }
        });
      }
      return jsonResponse({
        catalog: { ...catalog, catalogRevision: catalog.catalogRevision + 1 },
        bossCatalog: DEFAULT_BOSS_APPEARANCE_CATALOG,
        itemVariants: ITEM_VARIANT_CATALOG,
        modifiedFiles: ["packages/shared/src/data/player-appearance.catalog.json"]
      });
    }
    if (url === "/api/assets/import") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { category?: string };
      const assetKey = payload.category === "projectiles"
        ? "projectiles/ember-arrow.png"
        : payload.category === "armor/gloves"
          ? "armor/gloves/paired-test.png"
          : payload.category === "armor/boots"
            ? "armor/boots/paired-test.png"
            : "hair/hair-test-replaced.png";
      return jsonResponse({
        stagingToken: "replacement-token",
        assetKey,
        relativeFile: `packages/player-renderer/src/assets/player-appearance/${assetKey}`,
        width: 1024,
        height: 1024,
        bytes: 3,
        contentHash: "d".repeat(64)
      });
    }
    if (url === "/api/runtime-assets/publish") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        presentation: typeof RUNTIME_PNG_PRESENTATION_CATALOG;
      };
      const presentation = {
        ...payload.presentation,
        revision: payload.presentation.revision + 1
      };
      return jsonResponse({
        presentation,
        inventory: { assets: [], presentation },
        modifiedFiles: ["packages/shared/src/data/runtime-png-presentation.json"]
      });
    }
    if (/^\/api\/interior-catalog\/[^/]+\/publish$/u.test(url)) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { space: { id: string }; expectedCatalogRevision: number };
      const interior = interiorCatalogFromLegacy();
      return jsonResponse({
        catalogRevision: payload.expectedCatalogRevision + 1,
        library: { ...interior.library, catalogRevision: payload.expectedCatalogRevision + 1 },
        spaces: interior.spaces,
        spaceRevisions: Object.fromEntries(interior.spaces.map((space) => [space.id, space.revision])),
        modifiedFiles: ["packages/shared/src/data/interiors/_library.json"]
      });
    }
    if (url === "/api/runtime-assets/discard") return jsonResponse({
      assets: [],
      presentation: RUNTIME_PNG_PRESENTATION_CATALOG
    });
    if (url === "/api/desktop/status") return jsonResponse(
      input.desktop
        ? { available: true, appVersion: "1.20.0", contractVersion: 20 }
        : { available: false }
    );
    if (url === "/api/desktop/release-status") return jsonResponse({
      branch: "feature/studio",
      commitSha: "a".repeat(40),
      worktreeClean: true,
      featurePushed: false,
      featureIntegrated: false,
      featurePublished: false,
      integrationGeneration: "t399",
      integrationSha: "b".repeat(40),
      masterSha: "c".repeat(40),
      integrationPublished: false
    });
    if (url === "/api/remote/status") {
      return jsonResponse({
        connected: true,
        serverSha: "b".repeat(40),
        catalogRevision: input.remoteRevision
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function studioCatalog(): PlayerAppearanceCatalog {
  const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
  catalog.appearances = [
    {
      appearanceId: "studio_sword",
      displayName: "Studio Sword",
      familyId: "one_handed_sword",
      assetKey: "weapons/studio-sword.png",
      cosmetic: false,
      equipmentDefinitionId: "starter_sword",
      placements: { idle: { offsetX: 2, offsetY: -1 } }
    },
    {
      appearanceId: "hair_test",
      displayName: "Hair Test",
      familyId: "hair",
      assetKey: "hair/hair-test.png",
      cosmetic: true,
      salon: {
        state: "selectable",
        sortOrder: 30,
        accessType: "free",
        gameCreditPrice: 0,
        productId: null
      },
      placements: {}
    },
    {
      appearanceId: "beard_test",
      displayName: "Beard Test",
      familyId: "beard",
      assetKey: "cosmetics/beard-test.png",
      cosmetic: false,
      salon: {
        state: "selectable",
        sortOrder: 10,
        accessType: "free",
        gameCreditPrice: 0,
        productId: null
      },
      placements: {}
    },
    {
      appearanceId: "hammer",
      displayName: "Hammer",
      familyId: "staff",
      assetKey: "weapons/hammer.png",
      cosmetic: false,
      compatibleEquipmentDefinitionIds: ["starter_staff"],
      placements: {},
      retired: true
    },
    {
      appearanceId: "starter-staff",
      displayName: "Staff",
      familyId: "staff",
      assetKey: "weapons/staff.png",
      cosmetic: false,
      equipmentDefinitionId: "starter_staff",
      placements: {}
    },
    {
      appearanceId: "padded_tunic",
      displayName: "Tunic",
      familyId: "chest_tunic",
      assetKey: "armor/chest/tunic.png",
      cosmetic: false,
      equipmentDefinitionId: "padded_tunic",
      placements: {}
    },
    {
      appearanceId: "training_shield",
      displayName: "Training Shield",
      familyId: "shield",
      assetKey: "shields/training-shield.png",
      cosmetic: false,
      equipmentDefinitionId: "training_shield",
      placements: {}
    },
    {
      appearanceId: "breast_plate",
      displayName: "Breastplate",
      familyId: "chest_breastplate",
      assetKey: "armor/chest/breastplate.png",
      cosmetic: false,
      equipmentDefinitionId: "breast_plate" as EquipmentDefinitionId,
      placements: {}
    }
  ];
  return catalog;
}
