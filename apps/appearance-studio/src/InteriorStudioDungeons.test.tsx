// @vitest-environment jsdom

import { DUNGEON_CATALOG as SHARED_DUNGEON_CATALOG, dungeonCatalogValidationIssues, fromDungeonCatalog, mergeInteriorLibrary, type DungeonCatalog, type InteriorCatalog } from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("./DungeonPlayTest.js", () => ({ DungeonPlayTest: (props: { mode: string; roomId: string; onExit(): void }) => <section aria-label="Isolated Play Test" data-mode={props.mode} data-room={props.roomId}><button onClick={props.onExit}>Exit Play Test</button></section> }));

import { InteriorStudio as DungeonStudio, type InteriorStudioHandle as DungeonStudioHandle } from "./InteriorStudio.js";
import { interiorEditingView } from "./interiorStudioModel.js";
import { createDungeonFromWizard, createDungeonResourceSpawnZone } from "./dungeonStudioV2.js";
import type { StudioSession } from "./bridgeTypes.js";
import type { StudioApi } from "./studioApi.js";

/** Stock catalog without the scaffolded Ashen Crypt and the Fangrock/Eyrie/Grove layouts: the view is alphabetical and these specs are Cistern Warrens-first. */
const EXCLUDED_DUNGEONS = ["ashen_crypt", "fangrock_cavern", "the_eyrie", "blightwood_grove", "wyrm_hollow"];
const DUNGEON_CATALOG: DungeonCatalog = {
  ...SHARED_DUNGEON_CATALOG,
  dungeons: SHARED_DUNGEON_CATALOG.dungeons.filter((dungeon) => !EXCLUDED_DUNGEONS.includes(dungeon.id)),
  entrances: SHARED_DUNGEON_CATALOG.entrances.filter((entrance) => !EXCLUDED_DUNGEONS.includes(entrance.dungeonId))
};

function sourcePath(file: string): string {
  const candidates = [
    resolve(process.cwd(), "apps/appearance-studio/src", file),
    resolve(process.cwd(), "src", file)
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Appearance Studio source file is missing: ${file}`);
  return path;
}

/** "+ New interior" with the default Dungeon kind, continuing into the dungeon wizard. */
async function openNewDungeonWizard(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "+ New interior" }));
  const dialog = screen.getByRole("dialog", { name: "New interior" });
  fireEvent.change(within(dialog).getByLabelText("Interior name"), { target: { value: "New Dungeon" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
}

async function enableAdvanced(): Promise<void> {
  fireEvent.click(await screen.findByRole("tab", { name: "Advanced" }));
  const allCategory = screen.queryByRole("tab", { name: "Everything" });
  if (allCategory) fireEvent.click(allCategory);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDivElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(SVGSVGElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

describe("Interior Studio workspace on dungeon spaces", () => {
  it("defaults to a plain five-step workflow and keeps Advanced systems available without dirtying data", async () => {
    const onDirtyChange = vi.fn();
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={onDirtyChange} onBusyChange={() => undefined} onMessage={() => undefined} />);

    expect((await screen.findByRole("tab", { name: "Simple" })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Play Test" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Things to Add" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Room Tools" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Map status" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Logic" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Geometry" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Resources" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Chests & Loot" })).toBeTruthy();
    expect(screen.queryByLabelText("anchors")).toBeNull();
    const expectCurrentStep = (label: string): void => {
      const current = Array.from(document.querySelectorAll<HTMLElement>('[aria-current="step"]'));
      expect(current).toHaveLength(1);
      expect(current[0]?.textContent).toBe(label);
    };
    expectCurrentStep("1 Room Look");

    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    expect(screen.getByRole("tab", { name: "Resources" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "1 Room Look" }));
    expect(screen.getByRole("tab", { name: "Room" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "2 Enemies" }));
    expectCurrentStep("2 Enemies");
    expect(screen.getAllByRole("tab", { name: "Enemies" })[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "3 Chest" }));
    expectCurrentStep("3 Chest");
    expect((screen.getByLabelText("Search library") as HTMLInputElement).value).toBe("chest");
    expect(screen.getByText("Treasure Chest")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "4 Finish Room" }));
    expectCurrentStep("4 Finish Room");
    expect(screen.getByRole("tab", { name: "Room" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "5 Play Test" }));
    expect(screen.getByLabelText("Isolated Play Test").getAttribute("data-mode")).toBe("full");
    fireEvent.click(screen.getByRole("button", { name: "Exit Play Test" }));
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);

    await enableAdvanced();
    expect(screen.getByRole("tab", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prefab Library" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Logic" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Geometry" })).toBeTruthy();
    expect(screen.getByLabelText("anchors")).toBeTruthy();
    expect(screen.getAllByText("Advanced metadata").length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: /^Flow/u })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Play Test" })).toBeTruthy();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it("offers a plain PNG form in Simple mode and keeps technical import options optional", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Add PNG" }));
    const form = screen.getByRole("form", { name: "Add PNG" });
    expect(within(form).getByLabelText("Name")).toBeTruthy();
    expect(within(form).getByLabelText("PNG file")).toBeTruthy();
    expect(within(form).getByLabelText("Use as")).toBeTruthy();
    const moreOptions = within(form).getByText("More options").closest("details")!;
    expect(moreOptions.open).toBe(false);

    fireEvent.click(within(moreOptions).getByText("More options"));
    expect(moreOptions.open).toBe(true);
    expect(within(moreOptions).getByText(/Prefab ID/u)).toBeTruthy();
    expect(within(moreOptions).getByLabelText("Layer")).toBeTruthy();
    expect(within(moreOptions).getByLabelText("Render mode")).toBeTruthy();
  });

  it("persists the real archetype id selected from the Simple enemy editor", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    addWalkMob(catalog, "simple_enemy", 400, 400);
    const api = studioApi(catalog);
    renderUi(<DungeonStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);

    await screen.findByRole("heading", { name: "Things to Add" });
    fireEvent.pointerDown(document.querySelector(".dungeon-mob-marker")!);
    fireEvent.click(screen.getByRole("tab", { name: "Selected" }));
    const enemyType = screen.getByLabelText("Enemy type") as HTMLSelectElement;
    expect(Array.from(enemyType.options).find((option) => option.textContent === "Orc Brute")?.value).toBe("orc_brute");
    fireEvent.change(enemyType, { target: { value: "orc_brute" } });
    expect(enemyType.value).toBe("orc_brute");
    expect(screen.getByText("Enemy · Orc Brute")).toBeTruthy();
    await waitFor(() => expect(Object.values(localStorage).join("\n")).toContain('"archetype":"orc_brute"'));
  });

  it("keeps the constructed Cistern Warrens entrance structure-bound after catalog recovery", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    catalog.entrances = [];
    catalog.dungeons[0]!.portals.find((portal) => portal.id === catalog.dungeons[0]!.entrance.portalId)!.enabled = false;
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "4 Finish Room" }));
    fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
    const card = screen.getByRole("region", { name: "Game entrance" });
    expect(card.textContent).toContain("Structure-bound");
    expect(within(card).queryByRole("button", { name: "Add entrance" })).toBeNull();
    expect(within(card).queryByLabelText("Latitude")).toBeNull();
    expect(within(card).queryByLabelText("Longitude")).toBeNull();
  });

  it("explains that constructed Cistern Warrens entrances are structure-bound", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "4 Finish Room" }));
    fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
    const card = screen.getByRole("region", { name: "Game entrance" });
    expect(card.textContent).toContain("Structure-bound");
    expect(card.textContent).toContain("Do not enter fake overworld coordinates here");
    expect(card.textContent).toContain("canonical Cistern Warrens room graph");
    expect(within(card).queryByRole("button", { name: "Add entrance" })).toBeNull();
    expect(within(card).queryByLabelText("Latitude")).toBeNull();
    expect(within(card).queryByLabelText("Longitude")).toBeNull();
  });

  it("offers a mobile-safe room rail, authoring controls, validation, and Walk Test", async () => {
    const studioStyles = readFileSync(sourcePath("styles.css"), "utf8");
    expect(studioStyles).toMatch(/\.studio-worktree-identity\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/u);
    expect(studioStyles).toMatch(/\.status-bar\s*\{[^}]*margin: 0 -10px/u);
    expect(studioStyles).toMatch(/\.dungeon-room-rail\s*\{[^}]*overflow-x: auto/u);
    expect(studioStyles).toMatch(/\.dungeon-mobile-actions\s*\{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/u);
    expect(studioStyles).toMatch(/\.dungeon-stage\.walk canvas\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*pointer-events: none;/u);
    const paddedCatalog = structuredClone(DUNGEON_CATALOG);
    paddedCatalog.dungeons[0]!.rooms[0]!.camera.fitPadding = 20;
    const api = studioApi(paddedCatalog);
    renderUi(<DungeonStudio
      api={api}
      session={session}
      visible
      writesAllowed
      onDirtyChange={() => undefined}
      onBusyChange={() => undefined}
      onMessage={() => undefined}
    />);
    await enableAdvanced();

    expect(await screen.findByRole("listbox", { name: "Dungeon room graph" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Edit" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Play Test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Room" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Room" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByLabelText("Music asset")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Geometry" }));
    expect(screen.getByLabelText("Music asset")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Room" }));
    expect(screen.getByText(/Players move at half speed here/u)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Interior Studio" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
    expect(screen.getByText(/Dungeon settings · Shared persistent · reset when empty/u)).toBeTruthy();
    expect((screen.getByLabelText("Instance policy") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe("Shared persistent");
    const quickActions = screen.getByRole("navigation", { name: "Dungeon quick actions" });
    expect(quickActions).toBeTruthy();
    const mobileAdd = screen.getByRole("button", { name: "Add" });
    expect(mobileAdd.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(mobileAdd);
    expect(mobileAdd.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("complementary", { name: "Prefab add library" })).toBeTruthy();
    expect(screen.getByText("No catalog validation issues.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Click to place" }).length).toBeGreaterThan(0);
    const createObject = screen.getAllByRole("button", { name: "Create object" })[0]!;
    expect(createObject.hasAttribute("disabled")).toBe(false);
    fireEvent.click(createObject);
    const authorCanvas = screen.getByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(authorCanvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(authorCanvas, "pointerdown", 7, 500, 500);
    firePointer(authorCanvas, "pointerup", 7, 500, 500);
    expect(screen.getByRole("button", { name: "+ object" }).hasAttribute("disabled")).toBe(false);
    const objectType = screen.getByLabelText("Object type") as HTMLSelectElement;
    expect(objectType.value).toBe("chest");
    fireEvent.change(objectType, { target: { value: "switch" } });
    expect(objectType.value).toBe("switch");
    expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Play Test" }));
    expect(screen.getByLabelText("Isolated Play Test").getAttribute("data-mode")).toBe("full");

  });

  it("focuses the canvas without removing surrounding tools and Escape exits focus", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    await screen.findByLabelText("Hatch Landing authoring canvas");
    const focus = screen.getByRole("button", { name: "Focus canvas" });
    fireEvent.click(focus);
    const panel = screen.getByRole("button", { name: "Exit focus" }).closest(".dungeon-canvas-panel")!;
    expect(panel.classList.contains("focused")).toBe(true);
    expect(screen.getByRole("complementary", { name: "Prefab add library" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel.classList.contains("focused")).toBe(false);
    expect(screen.getByRole("button", { name: "Focus canvas" })).toBeTruthy();
  });

  it("zooms the Author view without dirtying authored catalog data", async () => {
    const onDirtyChange = vi.fn();
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={onDirtyChange} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    const preventWheelDefault = vi.spyOn(wheel, "preventDefault");
    fireEvent(canvas, wheel);
    expect(preventWheelDefault).toHaveBeenCalledTimes(1);
    expect(wheel.defaultPrevented).toBe(true);
    expect(canvas.getAttribute("style")).toContain("scale(1.1)");
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("adds a valid inactive draft room and saves it through the imperative handle", async () => {
    const api = studioApi();
    const ref = createRef<DungeonStudioHandle>();
    const onDirtyChange = vi.fn();
    renderUi(<DungeonStudio
      ref={ref}
      api={api}
      session={session}
      visible
      writesAllowed
      onDirtyChange={onDirtyChange}
      onBusyChange={() => undefined}
      onMessage={() => undefined}
    />);
    await enableAdvanced();
    await screen.findByRole("button", { name: "+ Room" });
    const roomOptionsBefore = screen.getAllByRole("option").filter((option) => option.tagName === "BUTTON").length;
    fireEvent.click(screen.getByRole("button", { name: "+ Room" }));
    expect(screen.getAllByRole("option").filter((option) => option.tagName === "BUTTON")).toHaveLength(roomOptionsBefore);
    fireEvent.change(screen.getAllByLabelText("Room name")[0]!, { target: { value: "Draft Room" } });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));
    expect(await screen.findByDisplayValue("Draft Room")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Active runtime room" }));
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect rooms" }));
    await vi.waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await ref.current?.save();
    expect(api.publishInteriorSpace).toHaveBeenCalledTimes(1);
    const published = publishedView(api);
    expect(published?.dungeons[0]?.rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Draft Room", active: true, retired: false, camera: expect.objectContaining({ fitPadding: 0 }) })
    ]));
    const newPortals = published?.dungeons[0]?.portals.filter((portal) => portal.source.kind === "room" && (portal.source.roomId === "draft_room_1" || (portal.destination.kind === "room" && portal.destination.roomId === "draft_room_1"))) ?? [];
    expect(newPortals).toHaveLength(2);
    expect(newPortals[0]?.reciprocalPortalId).toBe(newPortals[1]?.id);
    expect(newPortals[1]?.reciprocalPortalId).toBe(newPortals[0]?.id);
    expect(published?.dungeons[0]?.rooms.find((room) => room.id === "draft_room_1")?.objects)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "portal", portalId: expect.any(String) })]));
  });

  it("stages new PNG art as a prefab and selects it for tap placement", async () => {
    const api = studioApi(); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add art" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Custom Banner" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "decoration" } });
    const file = new File([new Uint8Array([137, 80, 78, 71])], "banner.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("PNG file"), { target: { files: [file] } });
    fireEvent.submit(screen.getByRole("button", { name: "Stage PNG & create prefab" }).closest("form")!);
    expect(api.importDungeonPng).toHaveBeenCalled();
    expect(await screen.findByText("Staged until Save")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Placing · click canvas" }).getAttribute("aria-pressed")).toBe("true");
    const canvas = screen.getByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(canvas, "pointerdown", 9, 450, 450); firePointer(canvas, "pointerup", 9, 450, 450);
    expect(screen.getByText(/ID · custom_banner/u)).toBeTruthy();
    await ref.current?.save();
    expect(publishedView(api)).toEqual(expect.objectContaining({ prefabs: expect.arrayContaining([expect.objectContaining({ id: "custom_banner", nativeWidth: 32, nativeHeight: 48 })]) }));
    expect(publishedTokens(api)).toEqual(["dungeon-art-token"]);
  });

  it("resizes selected art in Simple and stretches it to the full room in both authoring levels", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const room = catalog.dungeons[0]!.rooms[0]!;
    const api = studioApi(catalog);
    const ref = createRef<DungeonStudioHandle>();
    catalog.prefabs.push({
      id: "custom_decor", revision: "custom_decor-v1", name: "Custom Decoration", type: "decoration", retired: false,
      defaultWidth: 96, defaultHeight: 96, defaultLayerId: "above_player",
      assetKey: "apps/client/public/assets/dungeons/custom/custom-decor.png", renderMode: "sprite",
      nativeWidth: 64, nativeHeight: 128, pivotX: 0.5, pivotY: 1, defaultOpacity: 1, defaultRotationDeg: 0,
      defaultFlipX: false, defaultFlipY: false, stateAssets: [], defaultColliders: []
    });
    room.layers.above_player.push({
      id: "custom_decor_1", retired: false, prefabId: "custom_decor", prefabRevision: "custom_decor-v1",
      x: 200, y: 220, width: 96, height: 96, rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0
    });
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await screen.findByLabelText("Hatch Landing authoring canvas");

    firePointer(prefabArt("custom-decor.png"), "pointerdown", 101, 200, 220);
    expect(screen.getByText("Selected art · Custom Decoration")).toBeTruthy();
    const width = screen.getByLabelText("Width") as HTMLInputElement;
    const height = screen.getByLabelText("Height") as HTMLInputElement;
    expect(width.value).toBe("96");
    expect(height.value).toBe("96");
    fireEvent.change(width, { target: { value: "333" } });
    fireEvent.change(height, { target: { value: "444" } });
    expect(width.value).toBe("333");
    expect(height.value).toBe("444");
    expect(prefabArt("custom-decor.png").querySelector(".dungeon-prefab-hitbox")?.getAttribute("width")).toBe("333");
    expect(prefabArt("custom-decor.png").querySelector(".dungeon-prefab-hitbox")?.getAttribute("height")).toBe("444");

    fireEvent.click(screen.getByRole("button", { name: "Stretch to fill room as backdrop" }));
    const stretched = prefabArt("custom-decor.png");
    const stretchedImage = stretched.querySelector("image")!;
    const stretchedHitbox = stretched.querySelector(".dungeon-prefab-hitbox")!;
    expect(stretchedImage.getAttribute("preserveAspectRatio")).toBe("none");
    expect(stretchedHitbox.getAttribute("x")).toBe("-500");
    expect(stretchedHitbox.getAttribute("y")).toBe("-1000");
    expect(stretchedHitbox.getAttribute("width")).toBe("1000");
    expect(stretchedHitbox.getAttribute("height")).toBe("1000");
    expect(room.width).toBe(1000);
    expect(room.height).toBe(1000);

    await enableAdvanced();
    expect(screen.getByLabelText("Render mode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stretch to fill room as backdrop" })).toBeTruthy();
    await ref.current?.save();
    const publishedRoom = publishedView(api).dungeons[0]?.rooms[0];
    expect(publishedRoom?.layers.above_player.some((placement) => placement.id === "custom_decor_1")).toBe(false);
    expect(publishedRoom?.layers.background).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "custom_decor_1", x: 0, y: 0, width: 1000, height: 1000
    })]));
  });

  it("uses a selected prefab's default layer and translates its default colliders", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    catalog.prefabs[0]!.defaultColliders.push({ id: "solid_edge", retired: false, kind: "rectangle", x: 10, y: 20, width: 40, height: 30 });
    const api = studioApi(catalog); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const prefabCard = (await screen.findByText("Sewer Floor")).closest("article")!;
    fireEvent.click(prefabCard.querySelector("button")!);
    fireEvent.click(screen.getByRole("tab", { name: "Geometry" }));
    expect((screen.getByLabelText("Active layer") as HTMLSelectElement).value).toBe("background");
    const canvas = screen.getByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(canvas, "pointerdown", 41, 400, 400); firePointer(canvas, "pointerup", 41, 400, 400);
    const [, , roomWidthText, roomHeightText] = (canvas.getAttribute("viewBox") ?? "").split(" ");
    const roomWidth = Number(roomWidthText); const roomHeight = Number(roomHeightText);
    const placedFloor = Array.from(document.querySelectorAll<SVGRectElement>(".dungeon-prefab-tile")).at(-1)!;
    expect(Number(placedFloor.getAttribute("x"))).toBe(0); expect(Number(placedFloor.getAttribute("y"))).toBe(0);
    expect(Number(placedFloor.getAttribute("width"))).toBe(roomWidth); expect(Number(placedFloor.getAttribute("height"))).toBe(roomHeight);
    fireEvent.click(screen.getByLabelText("colliders"));
    const collider = Array.from(document.querySelectorAll<SVGRectElement>(".dungeon-collider")).at(-1)!;
    expect(Number(collider.getAttribute("x"))).toBeCloseTo(10 * roomWidth / 256);
    expect(Number(collider.getAttribute("y"))).toBeCloseTo(20 * roomHeight / 256);
    expect(Number(collider.getAttribute("width"))).toBeCloseTo(40 * roomWidth / 256);
    expect(Number(collider.getAttribute("height"))).toBeCloseTo(30 * roomHeight / 256);
  });

  it("places objects, mobs, and a reciprocal room door over full-room floor art", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const existingPortalIds = new Set(catalog.dungeons[0]!.portals.map((portal) => portal.id));
    const api = studioApi(catalog); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });

    const floorCard = screen.getByText("Sewer Floor").closest("article")!;
    fireEvent.click(floorCard.querySelector("button")!);
    firePointer(canvas, "pointerdown", 51, 400, 400); firePointer(canvas, "pointerup", 51, 400, 400);
    const floorHitbox = (): SVGRectElement => Array.from(document.querySelectorAll<SVGRectElement>(".dungeon-prefab-tile"))
      .at(-1)!.closest(".dungeon-prefab-art")!.querySelector(".dungeon-prefab-hitbox")!;

    const chestCard = screen.getByText("Treasure Chest").closest("article")!;
    fireEvent.click(chestCard.querySelector("button")!);
    firePointer(floorHitbox(), "pointerdown", 52, 300, 300); firePointer(floorHitbox(), "pointerup", 52, 300, 300);
    expect(screen.getByText(/^ID · dungeon_chest/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Goblin Mob/u }));
    firePointer(floorHitbox(), "pointerdown", 53, 500, 500); firePointer(floorHitbox(), "pointerup", 53, 500, 500);
    expect(screen.getByText(/^Mob · goblin/u)).toBeTruthy();

    const doorCard = screen.getByText("Sewer Door").closest("article")!;
    fireEvent.click(doorCard.querySelector("button")!);
    expect((screen.getByLabelText("Destination room") as HTMLSelectElement).value).toBe("overflow_channel");
    firePointer(floorHitbox(), "pointerdown", 54, 625, 475); firePointer(floorHitbox(), "pointerup", 54, 625, 475);

    fireEvent.keyDown(window, { key: "Escape" });
    firePointer(floorHitbox(), "pointerdown", 55, 400, 400); firePointer(floorHitbox(), "pointerup", 55, 400, 400);
    expect(screen.getByText(/^ID · sewer_floor/u)).toBeTruthy();
    const mobMarker = Array.from(document.querySelectorAll<SVGGElement>(".dungeon-mob-marker")).at(-1)!;
    firePointer(mobMarker, "pointerdown", 56, 500, 500); firePointer(mobMarker, "pointerup", 56, 500, 500);
    expect(screen.getByText(/^Mob · goblin/u)).toBeTruthy();

    await ref.current?.save();
    const published = publishedView(api);
    const dungeon = published?.dungeons[0];
    expect(dungeon).toBeDefined();
    if (!dungeon) throw new Error("Expected the published dungeon.");
    const addedPortals = dungeon.portals.filter((portal) => !existingPortalIds.has(portal.id));
    expect(addedPortals).toHaveLength(2);
    const sourcePortal = addedPortals.find((portal) => portal.source.kind === "room" && portal.source.roomId === "hatch_landing")!;
    const reciprocal = addedPortals.find((portal) => portal.id === sourcePortal.reciprocalPortalId)!;
    expect(reciprocal.reciprocalPortalId).toBe(sourcePortal.id);
    expect(sourcePortal).toEqual(expect.objectContaining({
      sourceApproachAnchorId: sourcePortal.source.kind === "room" ? sourcePortal.source.anchorId : "",
      sourceThresholdAnchorId: sourcePortal.source.kind === "room" ? sourcePortal.source.anchorId : "",
      destinationArrivalAnchorId: expect.any(String), conditions: ["always"], presentation: "door", enabled: true
    }));
    const sourceRoom = dungeon.rooms.find((room) => room.id === "hatch_landing")!;
    const sourceAnchor = sourceRoom.anchors.find((anchor) => sourcePortal.source.kind === "room" && anchor.id === sourcePortal.source.anchorId);
    expect(sourceAnchor).toEqual(expect.objectContaining({ x: 625, y: 475 }));
    const addedObjects = dungeon.rooms.flatMap((room) => room.objects).filter((object) => object.portalId && addedPortals.some((portal) => portal.id === object.portalId));
    expect(addedObjects).toHaveLength(2);
    expect(addedObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "portal", prefabId: "sewer_door", portalId: sourcePortal.id }),
      expect.objectContaining({ type: "portal", prefabId: "sewer_door", portalId: reciprocal.id })
    ]));
  });

  it("places either portal prefab as the existing world exit in a new one-room dungeon", async () => {
    const api = studioApi(); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await openNewDungeonWizard();
    fireEvent.change(screen.getByLabelText("Dungeon name"), { target: { value: "World Gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Create dungeon" }));
    fireEvent.click(screen.getByRole("tab", { name: "Doors" }));

    const doorCard = screen.getByText("Sewer Door").closest("article")!;
    const ladderCard = screen.getByText("Sewer Exit Ladder").closest("article")!;
    expect(within(doorCard).getByRole("button", { name: "Place" }).hasAttribute("disabled")).toBe(false);
    const ladderButton = within(ladderCard).getByRole("button", { name: "Place" });
    expect(ladderButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(ladderButton);
    expect(screen.getByText("This places or moves the dungeon exit to the game world.")).toBeTruthy();
    expect(screen.queryByLabelText("Destination room")).toBeNull();

    const canvas = screen.getByLabelText("World Gate Entrance authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    const capture = vi.fn(() => { throw new Error("placement must not capture the pointer"); });
    Object.defineProperty(canvas, "setPointerCapture", { configurable: true, value: capture });
    const floorHitbox = prefabArt("sewer-floor.png").querySelector<SVGRectElement>(".dungeon-prefab-hitbox")!;
    firePointer(floorHitbox, "pointerdown", 57, 600, 400); firePointer(floorHitbox, "pointerup", 57, 600, 400);
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Selected" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByDisplayValue("Return to world")).toBeTruthy();

    await ref.current?.save();
    const published = publishedView(api);
    const dungeon = published.dungeons.find((candidate) => candidate.id === "world_gate")!;
    expect(dungeonCatalogValidationIssues(published)).toEqual([]);
    expect(dungeon.portals).toHaveLength(2);
    expect(dungeon.escape.portalId).toBe("world_gate_entrance_to_world");
    const escapePortal = dungeon.portals.find((portal) => portal.id === dungeon.escape.portalId)!;
    expect(escapePortal.reciprocalPortalId).toBe(dungeon.entrance.portalId);
    expect(dungeon.portals.find((portal) => portal.id === dungeon.entrance.portalId)?.reciprocalPortalId).toBe(escapePortal.id);
    const room = dungeon.rooms[0]!;
    const exitObjects = room.objects.filter((object) => !object.retired && object.portalId === escapePortal.id);
    expect(exitObjects).toHaveLength(1);
    expect(exitObjects[0]).toEqual(expect.objectContaining({
      prefabId: "sewer_exit_ladder", prefabRevision: "sewer-exit-ladder-v1", name: "Return to world",
      interactionLabel: "Return to world", available: true, initialState: "closed", portalId: escapePortal.id
    }));
    expect(escapePortal.source.kind).toBe("room");
    const sourceAnchorId = escapePortal.source.kind === "room" ? escapePortal.source.anchorId : "";
    expect(room.anchors.find((anchor) => anchor.id === sourceAnchorId)).toEqual(expect.objectContaining({ x: 600, y: 400 }));
  });

  it.each(["missing", "retired"] as const)("repairs a %s configured world-exit anchor without duplicating its object", async (damage) => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = createDungeonFromWizard(catalog, {
      name: "Damaged Gate", themeId: "stone", backgroundColor: "#071116", floorColor: "#182a2d",
      wallColor: "#405052", accentColor: "#8fbc8f", instancePolicy: "party_ephemeral", resetPolicy: "when_empty",
      width: 1000, height: 1000
    });
    catalog.dungeons = [dungeon];
    catalog.entrances = [];
    const room = dungeon.rooms[0]!;
    const escape = dungeon.portals.find((portal) => portal.id === dungeon.escape.portalId)!;
    const sourceAnchorId = escape.source.kind === "room" ? escape.source.anchorId : "";
    if (damage === "missing") room.anchors = room.anchors.filter((anchor) => anchor.id !== sourceAnchorId);
    else room.anchors.find((anchor) => anchor.id === sourceAnchorId)!.retired = true;

    const api = studioApi(catalog); const ref = createRef<DungeonStudioHandle>(); const onDirtyChange = vi.fn();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={onDirtyChange} onBusyChange={() => undefined} onMessage={() => undefined} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Doors" }));
    const doorCard = screen.getByText("Sewer Door").closest("article")!;
    fireEvent.click(within(doorCard).getByRole("button", { name: "Place" }));
    const canvas = screen.getByLabelText("Damaged Gate Entrance authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(prefabArt("sewer-floor.png").querySelector<SVGRectElement>(".dungeon-prefab-hitbox")!, "pointerdown", 58, 700, 300);

    await vi.waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await ref.current?.save();
    const published = publishedView(api);
    expect(dungeonCatalogValidationIssues(published)).toEqual([]);
    const repairedDungeon = published.dungeons[0]!;
    const repairedRoom = repairedDungeon.rooms[0]!;
    const repairedAnchor = repairedRoom.anchors.find((anchor) => anchor.id === sourceAnchorId);
    expect(repairedAnchor).toEqual(expect.objectContaining({ retired: false, x: 700, y: 300 }));
    expect(repairedRoom.anchors.filter((anchor) => !anchor.retired && anchor.id === sourceAnchorId)).toHaveLength(1);
    expect(repairedRoom.objects.filter((object) => !object.retired && object.portalId === repairedDungeon.escape.portalId)).toHaveLength(1);
    expect(repairedDungeon.portals.filter((portal) => portal.id === repairedDungeon.escape.portalId)).toHaveLength(1);
  });

  it("retires the Cistern Warrens door without dangling portal references and keeps route errors visible", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    firePointer(prefabArt("sewer-door.png"), "pointerdown", 80, 950, 475);
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    let edited: DungeonCatalog | undefined;
    await waitFor(() => {
      edited = JSON.parse(localStorage.getItem(recoveryStorageKey()) ?? "null")?.catalog;
      expect(edited?.dungeons[0]?.portals.find((portal) => portal.id === "hatch-to-overflow")?.retired).toBe(true);
    });
    const issues = dungeonCatalogValidationIssues(edited!);
    expect(issues.some((issue) => issue.message.includes("missing portal"))).toBe(false);
    expect(issues.length).toBeGreaterThan(0);
    expect(edited!.dungeons[0]!.triggers).toEqual(DUNGEON_CATALOG.dungeons[0]!.triggers);
    expect(edited!.dungeons[0]!.rooms.map((room) => room.retired)).toEqual(DUNGEON_CATALOG.dungeons[0]!.rooms.map((room) => room.retired));
    fireEvent.click(screen.getByRole("button", { name: /Undo/u }));
    expect(screen.getByText("No catalog validation issues.")).toBeTruthy();
  });

  it("drags polygon resource zones as a bounded shape and undoes the whole drag", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    catalog.dungeons[0]!.rooms[0]!.resourceSpawnZones = [createDungeonResourceSpawnZone({
      id: "polygon_resource", shape: { id: "polygon_resource", retired: false, kind: "polygon", points: [{ x: 150, y: 625 }, { x: 350, y: 625 }, { x: 350, y: 850 }, { x: 150, y: 850 }] },
      resourceTypes: ["wood"], minCount: 1, maxCount: 2, minimumSpacing: 20, seed: 0, respawnSeconds: 300, resetOnRun: true, interactionRadius: 72
    })];
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    const polygon = (): SVGPolygonElement => document.querySelector("polygon.dungeon-resource-zone")!;
    firePointer(polygon(), "pointerdown", 81, 200, 700);
    firePointer(canvas, "pointermove", 81, 250, 750);
    expect(polygon().getAttribute("points")).toBe("200,675 400,675 400,900 200,900");
    firePointer(canvas, "pointermove", 81, 1000, 1000);
    firePointer(canvas, "pointerup", 81, 1000, 1000);
    expect(polygon().getAttribute("points")).toBe("800,775 1000,775 1000,1000 800,1000");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(polygon().getAttribute("points")).toBe("150,625 350,625 350,850 150,850");
  });

  it("direct-drags an initially unselected door by pointer delta without jumping", async () => {
    const api = studioApi(); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    const door = prefabArt("sewer-door.png");

    firePointer(door, "pointerdown", 61, 960, 485);
    expect(screen.getByText(/^ID · door-e$/u)).toBeTruthy();
    firePointer(canvas, "pointermove", 61, 985, 510);
    firePointer(canvas, "pointerup", 61, 985, 510);

    await ref.current?.save();
    const published = publishedView(api);
    const publishedDungeon = published?.dungeons[0];
    expect(publishedDungeon).toBeDefined();
    if (!publishedDungeon) throw new Error("Expected the published dungeon.");
    const entrance = publishedDungeon.rooms.find((room) => room.id === "hatch_landing")!;
    expect(entrance.anchors.find((anchor) => anchor.id === "door_e")).toEqual(expect.objectContaining({ x: 975, y: 500 }));
    expect(publishedDungeon.portals.find((portal) => portal.id === "hatch-to-overflow"))
      .toEqual(DUNGEON_CATALOG.dungeons[0]!.portals.find((portal) => portal.id === "hatch-to-overflow"));
  });

  it("labels a portal anchor with its destination and shows the object display name in Selected Item", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    await screen.findByLabelText("Hatch Landing authoring canvas");

    firePointer(prefabArt("sewer-door.png"), "pointerdown", 67, 950, 475);
    fireEvent.click(screen.getByRole("tab", { name: "Selected" }));

    expect(screen.getByText("Destination room:").parentElement?.textContent).toContain("Overflow Channel");
    expect(screen.getByText("Name is this object's display name; it does not choose the destination.")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Go East → Overflow Channel" }).getAttribute("value")).toBe("hatch-to-overflow");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Go to Room B" } });

    // The canvas names the door by where it leads, not by the object's display name.
    expect(screen.getByText("Door → Overflow Channel", { selector: "text" })).toBeTruthy();
    expect(screen.getByText("Destination room:").parentElement?.textContent).toContain("Overflow Channel");
  });

  it("records one undo snapshot for an actual direct-drag gesture", async () => {
    const api = studioApi();
    renderUi(<DungeonStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });

    firePointer(prefabArt("sewer-door.png"), "pointerdown", 66, 960, 485);
    firePointer(canvas, "pointermove", 66, 961, 486);
    firePointer(canvas, "pointerup", 66, 961, 486);
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true);

    firePointer(prefabArt("sewer-door.png"), "pointerdown", 65, 960, 485);
    firePointer(canvas, "pointermove", 65, 970, 495);
    firePointer(canvas, "pointermove", 65, 985, 510);
    firePointer(canvas, "pointerup", 65, 985, 510);

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undo);
    expect(prefabArt("sewer-door.png").getAttribute("transform")).toContain("translate(950 475)");
    expect(undo.hasAttribute("disabled")).toBe(true);
  });

  it("gives a direct entity drag priority over blank-canvas panning", async () => {
    const api = studioApi(); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(prefabArt("sewer-door.png"), "pointerdown", 62, 950, 475);
    firePointer(canvas, "pointermove", 62, 975, 500);
    firePointer(canvas, "pointerup", 62, 975, 500);

    expect(canvas.getAttribute("style")).toContain("translate(0px, 0px)");
    firePointer(canvas, "pointerdown", 64, 100, 100);
    firePointer(canvas, "pointermove", 64, 125, 110);
    firePointer(canvas, "pointermove", 64, 143, 122);
    firePointer(canvas, "pointermove", 64, 162, 134);
    firePointer(canvas, "pointerup", 64, 162, 134);
    expect(canvas.getAttribute("style")).toContain("translate(62px, 34px)");
    await ref.current?.save();
    const entrance = publishedView(api).dungeons[0]?.rooms.find((room) => room.id === "hatch_landing");
    expect(entrance?.anchors.find((anchor) => anchor.id === "door_e")).toEqual(expect.objectContaining({ x: 975, y: 500 }));
  });

  it("treats a full-room background placement as the Author pan surface", async () => {
    const api = studioApi();
    const ref = createRef<DungeonStudioHandle>();
    const onDirtyChange = vi.fn();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={onDirtyChange} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    const floor = prefabArt("hatch-landing-floor.png");
    const floorTransform = floor.getAttribute("transform");
    const floorHitbox = floor.querySelector<SVGRectElement>(".dungeon-prefab-hitbox")!;

    firePointer(floorHitbox, "pointerdown", 72, 620, 400);
    firePointer(canvas, "pointermove", 72, 640, 410);
    firePointer(canvas, "pointermove", 72, 665, 422);
    firePointer(canvas, "pointermove", 72, 682, 434);
    firePointer(canvas, "pointerup", 72, 682, 434);

    expect(canvas.getAttribute("style")).toContain("translate(62px, 34px)");
    expect(floor.getAttribute("transform")).toBe(floorTransform);
    expect(floor.classList.contains("selected")).toBe(true);
    expect(screen.getByText(/^ID · floor$/u)).toBeTruthy();
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false]);
    await ref.current?.save();
    expect(api.publishInteriorSpace).not.toHaveBeenCalled();
  });

  it("places the active prefab over an existing entity instead of dragging it", async () => {
    const api = studioApi(); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const canvas = await screen.findByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(screen.getByText("Treasure Chest").closest("article")!.querySelector("button")!);

    firePointer(prefabArt("sewer-door.png"), "pointerdown", 63, 950, 475);
    firePointer(canvas, "pointerup", 63, 950, 475);

    expect(screen.getByText(/^ID · dungeon_chest/u)).toBeTruthy();
    await ref.current?.save();
    const entrance = publishedView(api)
      .dungeons[0]!.rooms.find((room) => room.id === "hatch_landing");
    expect(entrance).toBeDefined();
    if (!entrance) throw new Error("Expected the Sewer entrance room.");
    expect(entrance.anchors.find((anchor) => anchor.id === "door_e")).toEqual(expect.objectContaining({ x: 950, y: 475 }));
    const chest = entrance.objects.find((object) => object.prefabId === "dungeon_chest");
    expect(entrance.anchors.find((anchor) => anchor.id === chest?.anchorId)).toEqual(expect.objectContaining({ x: 950, y: 475 }));
  });

  it("recovers staged dungeon art tokens across reload until Save", async () => {
    const firstApi = studioApi();
    const first = renderUi(<DungeonStudio api={firstApi} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add art" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reload Banner" } });
    const file = new File([new Uint8Array([137, 80, 78, 71])], "reload.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("PNG file"), { target: { files: [file] } });
    fireEvent.submit(screen.getByRole("button", { name: "Stage PNG & create prefab" }).closest("form")!);
    expect(await screen.findByText("Staged until Save")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(recoveryStorageKey()) ?? "null")).toEqual(expect.objectContaining({
      pendingDungeonAssets: [{ stagingToken: "dungeon-art-token", prefabId: "reload_banner" }]
    })));
    first.unmount();

    const reloadedApi = studioApi(); const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={reloadedApi} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    expect(await screen.findByText("Staged until Save")).toBeTruthy();
    await ref.current?.save();
    expect(publishedView(reloadedApi)).toEqual(expect.objectContaining({ prefabs: expect.arrayContaining([expect.objectContaining({ id: "reload_banner" })]) }));
    expect(publishedTokens(reloadedApi)).toEqual(["dungeon-art-token"]);
  });

  it("keeps Add art open when staging fails", async () => {
    const api = studioApi();
    vi.mocked(api.importDungeonPng).mockRejectedValueOnce(new Error("PNG staging failed"));
    renderUi(<DungeonStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add art" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Broken Banner" } });
    fireEvent.change(screen.getByLabelText("PNG file"), { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "broken.png", { type: "image/png" })] } });
    fireEvent.submit(screen.getByRole("button", { name: "Stage PNG & create prefab" }).closest("form")!);
    expect(await screen.findByText("PNG staging failed")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("keeps a structurally plausible semantically-invalid recovery draft for the exact revision", async () => {
    const recovered = structuredClone(DUNGEON_CATALOG);
    recovered.dungeons[0]!.rooms[0]!.name = "";
    localStorage.setItem(recoveryStorageKey(), JSON.stringify({
      baseCatalogRevision: recovered.catalogRevision,
      catalog: recovered,
      savedAt: "2026-08-26T12:00:00.000Z"
    }));
    const onMessage = vi.fn();
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={onMessage} />);
    const name = await screen.findByLabelText("Room name") as HTMLInputElement;
    expect(name.value).toBe("");
    expect(screen.getByText(/1 issue/u)).toBeTruthy();
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/Recovered unsaved Interior Studio edits/u));
  });

  it("explains a blocked save and opens the unfinished dungeon with the first empty encounter", async () => {
    const recovered = catalogWithEmptyDraftDungeon();
    localStorage.setItem(recoveryStorageKey(), JSON.stringify({
      baseCatalogRevision: recovered.catalogRevision,
      catalog: recovered,
      savedAt: "2026-09-03T16:00:00.000Z"
    }));
    const api = studioApi();
    const onMessage = vi.fn();
    const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={onMessage} />);
    await screen.findByLabelText("Room name");

    await act(async () => { await ref.current?.save(); });

    const message = "Save blocked: fix 1 map issue. La Granja · La Granja Entrance — has an empty encounter. Add an enemy or delete the empty encounter.";
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect((screen.getByLabelText("Interior") as HTMLSelectElement).value).toBe("la_granja");
    expect(within(screen.getByRole("tablist", { name: "Room inspector tasks" })).getByRole("tab", { name: "Enemies" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("has an empty encounter. Add an enemy or delete the empty encounter.")).toBeTruthy();
    expect(api.publishInteriorSpace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete empty encounter" }));
    expect(screen.getByText("No setup problems found.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("guards deleting the last mob when an encounter trigger would be orphaned", async () => {
    const catalog = catalogWithMobDeletionFixture({ trigger: true });
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.change(await screen.findByLabelText("Interior"), { target: { value: "la_granja" } });
    await waitFor(() => expect(document.querySelector(".dungeon-mob-marker")).toBeTruthy());
    fireEvent.pointerDown(document.querySelector(".dungeon-mob-marker")!);
    fireEvent.click(screen.getByRole("tab", { name: "Selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot remove the last enemy while this encounter has trigger recipes");
    expect(document.querySelectorAll(".dungeon-mob-marker")).toHaveLength(1);
  });

  it("guards retiring a summoning leader while active adds still reference it", async () => {
    const catalog = catalogWithMobDeletionFixture({ summonedAdd: true });
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.change(await screen.findByLabelText("Interior"), { target: { value: "la_granja" } });
    await waitFor(() => expect(document.querySelector(".dungeon-mob-marker")).toBeTruthy());
    fireEvent.pointerDown(document.querySelector(".dungeon-mob-marker")!);
    fireEvent.click(screen.getByRole("tab", { name: "Selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot delete a summoning leader while active summoned adds reference it");
    expect(document.querySelectorAll(".dungeon-mob-marker")).toHaveLength(2);
  });

  it("deletes only an unfinished recovered dungeon and preserves other dungeon edits", async () => {
    const recovered = catalogWithEmptyDraftDungeon();
    recovered.dungeons[0]!.rooms[0]!.name = "Preserved City Hatch Landing";
    localStorage.setItem(recoveryStorageKey(), JSON.stringify({
      baseCatalogRevision: recovered.catalogRevision,
      catalog: recovered,
      savedAt: "2026-09-03T16:00:00.000Z"
    }));
    const api = studioApi();
    const onMessage = vi.fn();
    const ref = createRef<DungeonStudioHandle>();
    renderUi(<DungeonStudio ref={ref} api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={onMessage} />);
    const dungeonSelect = await screen.findByLabelText("Interior") as HTMLSelectElement;

    expect(screen.queryByRole("button", { name: "Delete unfinished dungeon" })).toBeNull();
    fireEvent.change(dungeonSelect, { target: { value: "la_granja" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete unfinished dungeon" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete unfinished dungeon confirmation" });
    expect(confirmation.textContent).toContain("Your other dungeon edits stay exactly as they are.");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete unfinished dungeon" }));

    expect((screen.getByLabelText("Interior") as HTMLSelectElement).value).toBe("cistern_warrens");
    expect(screen.queryByRole("option", { name: "La Granja" })).toBeNull();
    expect(screen.getByText("No setup problems found.")).toBeTruthy();
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/Removed unfinished dungeon “La Granja”/u));

    await act(async () => { await ref.current?.save(); });
    const published = publishedView(api);
    expect(published.dungeons.map((dungeon) => dungeon.id)).not.toContain("la_granja");
    expect(published.dungeons[0]!.rooms[0]!.name).toBe("Preserved City Hatch Landing");
  });

  it("normalizes a recovered pre-entrance catalog without losing its edits", async () => {
    const recovered = structuredClone(DUNGEON_CATALOG) as DungeonCatalog & { entrances?: DungeonCatalog["entrances"] };
    recovered.dungeons[0]!.rooms[0]!.name = "Recovered legacy room";
    Reflect.deleteProperty(recovered, "entrances");
    localStorage.setItem(recoveryStorageKey(), JSON.stringify({
      baseCatalogRevision: recovered.catalogRevision,
      catalog: recovered,
      savedAt: "2026-08-26T12:00:00.000Z"
    }));
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    expect((await screen.findByLabelText("Room name") as HTMLInputElement).value).toBe("Recovered legacy room");
    fireEvent.click(screen.getByRole("button", { name: "4 Finish Room" }));
    fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
    expect(screen.getByRole("region", { name: "Game entrance" }).textContent).toContain("Structure-bound");
  });

  it("discards recovered staging tokens when the catalog revision changed", async () => {
    const recovered = structuredClone(DUNGEON_CATALOG);
    localStorage.setItem(recoveryStorageKey(), JSON.stringify({
      baseCatalogRevision: recovered.catalogRevision - 1,
      catalog: recovered,
      pendingDungeonAssets: [{ stagingToken: "stale-dungeon-token", prefabId: "stale_prefab" }],
      savedAt: "2026-08-26T12:00:00.000Z"
    }));
    const api = studioApi();
    renderUi(<DungeonStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await screen.findByLabelText("Room name");
    // A draft made on other data is offered, never applied; discarding it drops its staged PNGs.
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Old unsaved draft" })).getByRole("button", { name: "Discard old draft" }));
    await waitFor(() => expect(api.discardDungeonAssets).toHaveBeenCalledWith(["stale-dungeon-token"]));
    expect(localStorage.getItem(recoveryStorageKey())).toBeNull();
  });

  it("shows a loaded unsupported trigger event without offering it for new recipes", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    catalog.dungeons[0]!.triggers.push({
      id: "legacy_item_event", retired: false, enabled: false, scope: "party", repetition: "once", cooldownMs: 0,
      event: { type: "item_owned", itemId: "legacy_item", quantity: 1 },
      conditions: { mode: "all", items: [] }, actions: [{ type: "complete_dungeon" }]
    } as unknown as DungeonCatalog["dungeons"][number]["triggers"][number]);
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.click(await screen.findByRole("tab", { name: "Logic" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit other recipes" }));
    const eventType = (await screen.findAllByLabelText("When this happens") as HTMLSelectElement[]).find((select) => select.value === "item_owned")!;
    expect(eventType.value).toBe("item_owned");
    expect(eventType.selectedOptions[0]?.textContent).toMatch(/legacy unsupported event/u);
    expect(Array.from(eventType.options).filter((option) => option.value === "item_owned")).toHaveLength(1);
    expect(Array.from(eventType.options).map((option) => option.value)).not.toContain("quest_flag");
  });

  it("keeps the loaded draft when health polling replaces the equivalent session object", async () => {
    const api = studioApi();
    const view = renderUi(<DungeonStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    const roomName = await screen.findByLabelText("Room name") as HTMLInputElement;
    fireEvent.change(roomName, { target: { value: "Polling-safe draft" } });
    view.rerender(<DungeonStudio api={api} session={{ ...session, server: { ...session.server, startedAt: new Date(1_000).toISOString() } }} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    expect((screen.getByLabelText("Room name") as HTMLInputElement).value).toBe("Polling-safe draft");
    expect(api.loadInteriorCatalog).toHaveBeenCalledTimes(1);
  });

  it("offers only runtime-supported direct portal conditions", async () => {
    const source = readFileSync(sourcePath("InteriorStudio.tsx"), "utf8");
    expect(source).toContain('<option value="always">always</option>');
    expect(source).toContain('legacy/future unavailable');
    expect(source).toMatch(/Use encounter portal locks or a .set portal locked. trigger action/u);
    expect(source).not.toContain('["always", "dungeon_active", "unlocked", "boss_defeated"].map');
  });

  it("creates a second encounter and assigns a selected mob to it", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.click(await screen.findByRole("button", { name: /Goblin Mob/u }));
    const canvas = screen.getByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(canvas, "pointerdown", 31, 350, 350); firePointer(canvas, "pointerup", 31, 350, 350);
    expect(screen.queryByText(/Placing Goblin/u)).toBeNull();
    fireEvent.click(within(screen.getByRole("tablist", { name: "Room inspector tasks" })).getByRole("tab", { name: "Enemies" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Encounter" }));
    expect(screen.getByRole("button", { name: "Placing mobs here · Wave 1" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Goblin Mob/u }));
    firePointer(canvas, "pointerdown", 32, 650, 650); firePointer(canvas, "pointerup", 32, 650, 650);
    const encounter = screen.getByLabelText("Encounter") as HTMLSelectElement;
    expect(encounter.options).toHaveLength(2);
    expect(encounter.value).toBe(encounter.options[1]!.value);
    expect(screen.getByText("No catalog validation issues.")).toBeTruthy();
  });

  it("creates a schema-v2 dungeon from the mobile wizard and authors a mob recipe", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    await openNewDungeonWizard();
    fireEvent.change(screen.getByLabelText("Dungeon name"), { target: { value: "Sunken Keep" } });
    expect(Array.from((screen.getByLabelText("Theme") as HTMLSelectElement).options).map((option) => option.value)).not.toContain("custom");
    expect(Array.from((screen.getByLabelText("First room size") as HTMLSelectElement).options).map((option) => option.value)).not.toContain("custom");
    const technicalId = screen.getByText(/Dungeon ID/u);
    expect((technicalId.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(technicalId.closest("details")!.querySelector("summary")!);
    expect(screen.getByLabelText("Technical theme ID")).toBeTruthy();
    expect(screen.getByLabelText("Exact room width")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create dungeon" }));
    expect((screen.getByLabelText("Interior") as HTMLSelectElement).value).toBe("sunken_keep");
    expect(screen.getByText("No catalog validation issues.")).toBeTruthy();
    const floor = document.querySelector(".dungeon-prefab-tile");
    expect(floor?.getAttribute("width")).toBe("1000");
    expect(floor?.getAttribute("height")).toBe("1000");
    fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
    expect(screen.getByText(/needs world entrance binding/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Goblin Mob/u }));
    const canvas = screen.getByLabelText("Sunken Keep Entrance authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(canvas, "pointerdown", 8, 400, 400);
    firePointer(canvas, "pointerup", 8, 400, 400);
    expect(screen.queryByText(/Placing Goblin/u)).toBeNull();
    expect(screen.getAllByText(/Sunken Keep Entrance Encounter/u).length).toBeGreaterThan(0);
    fireEvent.click(within(screen.getByRole("tablist", { name: "Room inspector tasks" })).getByRole("tab", { name: "Enemies" }));
    fireEvent.click(screen.getByRole("button", { name: /\+ Wave · choose first mob for Wave 2/u }));
    expect(screen.getByText(/Wave 2/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Goblin Mob/u }));
    firePointer(canvas, "pointerdown", 9, 600, 600);
    firePointer(canvas, "pointerup", 9, 600, 600);
    fireEvent.click(within(screen.getByRole("tablist", { name: "Room inspector tasks" })).getByRole("tab", { name: "Enemies" }));
    expect((screen.getByLabelText("Wave for goblin_2") as HTMLSelectElement).value).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Remove wave 2 · move mobs safely" }));
    expect((screen.getByLabelText("Wave for goblin_2") as HTMLSelectElement).value).toBe("1");
    expect(screen.getByText("No catalog validation issues.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Logic" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Trigger recipe" }));
    expect(screen.getByText(/Nothing is created until you choose/u)).toBeTruthy();
    expect(screen.queryByLabelText("When this happens")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Room entered → Start encounter" }));
    expect(screen.getByText(/When room enter/u)).toBeTruthy();
    const eventType = screen.getByLabelText("When this happens") as HTMLSelectElement;
    expect(Array.from(eventType.options).map((option) => option.value)).not.toContain("item_owned");
    expect(Array.from(eventType.options).map((option) => option.value)).not.toContain("quest_flag");
    fireEvent.change(eventType, { target: { value: "timer" } });
    fireEvent.change(screen.getByLabelText("Timer delay ms"), { target: { value: "2500" } });
    expect((screen.getByLabelText("Timer delay ms") as HTMLInputElement).value).toBe("2500");
    fireEvent.change(screen.getByLabelText("Action 1 type"), { target: { value: "set_object_available" } });
    expect(screen.getByLabelText("Object availability target")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Object available"), { target: { value: "false" } });
    expect((screen.getByLabelText("Object available") as HTMLSelectElement).value).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "+ Action" }));
    expect((screen.getByLabelText("Action 2 type") as HTMLSelectElement).value).toBe("play_cue");
    fireEvent.change(screen.getByLabelText("Action 2 type"), { target: { value: "play_cue" } });
    fireEvent.change(screen.getByLabelText("Cue ID"), { target: { value: "gate open" } });
    fireEvent.click(screen.getByRole("button", { name: "Move action 2 up" }));
    expect((screen.getByLabelText("Action 1 type") as HTMLSelectElement).value).toBe("play_cue");
    fireEvent.click(screen.getByRole("button", { name: "Remove action 2" }));
    expect(screen.queryByLabelText("Action 2 type")).toBeNull();
    expect((screen.getByLabelText("Action 1 type") as HTMLSelectElement).value).toBe("play_cue");
    fireEvent.click(screen.getByRole("button", { name: "+ Condition" }));
    expect((screen.getByLabelText("Condition type") as HTMLSelectElement).value).toBe("dungeon_flag");
    fireEvent.change(screen.getByLabelText("Condition type"), { target: { value: "player_count" } });
    expect((screen.getByLabelText("Condition type") as HTMLSelectElement).value).toBe("player_count");
  });

  it("authors and Walk Tests the complete one-room quick setup without claiming a live binding", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await openNewDungeonWizard();
    fireEvent.change(screen.getByLabelText("Dungeon name"), { target: { value: "One Room Crypt" } });
    fireEvent.click(screen.getByRole("button", { name: "Create dungeon" }));

    fireEvent.click(screen.getByRole("button", { name: "2 Enemies" }));
    fireEvent.click(screen.getByRole("button", { name: "Goblin" }));
    const canvas = screen.getByLabelText("One Room Crypt Entrance authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    firePointer(canvas, "pointerdown", 108, 400, 400); firePointer(canvas, "pointerup", 108, 400, 400);

    fireEvent.click(screen.getByRole("button", { name: "3 Chest" }));
    const chestCard = screen.getByText("Treasure Chest").closest("article")!;
    fireEvent.click(within(chestCard).getByRole("button", { name: "Place" }));
    firePointer(canvas, "pointerdown", 109, 600, 400); firePointer(canvas, "pointerup", 109, 600, 400);
    fireEvent.click(screen.getByRole("button", { name: "4 Finish Room" }));

    const setup = screen.getByRole("region", { name: "Finish this room" });
    expect(setup.textContent).toContain("Place one or more enemies");
    const wire = screen.getByRole("button", { name: "Set up combat and chest" });
    expect(wire.hasAttribute("disabled")).toBe(false);
    fireEvent.click(wire);
    expect(setup.textContent).toContain("Enemies appear when the player enters");
    expect(setup.textContent).toContain("The exit stays closed during the fight");
    expect(setup.textContent).toContain("The chest opens after the fight");
    expect(setup.textContent).not.toContain("Chest rewards still need final game hookup");
    const wired = screen.getByRole("button", { name: "Combat and chest are set up" });
    expect(wired.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("No setup errors")).toBeTruthy();
    const readiness = screen.getByLabelText("Dungeon readiness summary");
    expect(readiness.textContent).toContain("Map fileReady to save");
    expect(readiness.textContent).toContain("Play TestReady");
    expect(readiness.textContent).toContain("Needs final game hookup");

    fireEvent.click(screen.getByRole("button", { name: "5 Play Test" }));
    expect(screen.getByLabelText("Isolated Play Test").getAttribute("data-mode")).toBe("full");
  });

  it("arms one-shot entity placement without mutating the room until the canvas click", async () => {
    const dirty = vi.fn();
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={dirty} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    await screen.findByRole("tab", { name: "Selected" });
    fireEvent.click(screen.getByRole("tab", { name: "Selected" }));
    const canvas = screen.getByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(screen.getByRole("button", { name: "+ anchor" }));
    expect(screen.getByRole("status").textContent).toContain("Placing Anchor");
    expect(dirty).not.toHaveBeenCalledWith(true);
    firePointer(canvas, "pointerdown", 90, 225, 325); firePointer(canvas, "pointerup", 90, 225, 325);
    expect((screen.getByLabelText("X") as HTMLInputElement).value).toBe("225");
    expect((screen.getByLabelText("Y") as HTMLInputElement).value).toBe("325");
    expect(screen.queryByText("Placing Anchor")).toBeNull();
  });

  it("lets a mob or prefab selection replace an armed collider placement", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    fireEvent.click(await screen.findByRole("tab", { name: "Selected" }));
    const canvas = screen.getByLabelText("Hatch Landing authoring canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
    const colliderCount = document.querySelectorAll(".dungeon-collider").length;

    fireEvent.click(screen.getByRole("button", { name: "+ collider" }));
    fireEvent.click(screen.getByRole("button", { name: /Goblin Mob/u }));
    firePointer(canvas, "pointerdown", 91, 300, 300); firePointer(canvas, "pointerup", 91, 300, 300);
    expect((screen.getByLabelText("Archetype") as HTMLSelectElement).value).toBe("goblin");
    expect(document.querySelectorAll(".dungeon-collider")).toHaveLength(colliderCount);

    fireEvent.click(screen.getByRole("button", { name: "+ collider" }));
    const chestCard = screen.getByText("Treasure Chest").closest("article")!;
    fireEvent.click(chestCard.querySelector("button")!);
    firePointer(canvas, "pointerdown", 92, 700, 300); firePointer(canvas, "pointerup", 92, 700, 300);
    expect((screen.getByLabelText("Object type") as HTMLSelectElement).value).toBe("chest");
    expect(document.querySelectorAll(".dungeon-collider")).toHaveLength(colliderCount);
  });

  it("clears a newly edited room recipe when switching rooms", async () => {
    renderUi(<DungeonStudio api={studioApi()} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    const roomRail = await screen.findByRole("listbox", { name: "Dungeon room graph" });
    const roomButton = (name: string): HTMLButtonElement => Array.from(roomRail.querySelectorAll("button")).find((button) => button.textContent?.includes(name))!;
    fireEvent.click(roomButton("Overflow Channel"));
    fireEvent.click(screen.getByRole("tab", { name: "Logic" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Trigger recipe" }));
    fireEvent.click(screen.getByRole("button", { name: "Room entered → Start encounter" }));
    // Overflow Channel already authors one room-enter trigger, so the new recipe makes two.
    expect(screen.getAllByText(/When room enter/u)).toHaveLength(2);
    fireEvent.click(roomButton("Hatch Landing"));
    expect(screen.queryByText(/When room enter/u)).toBeNull();
  });

  it("groups validation issues and opens the exact invalid object in Selected Item", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const object = catalog.dungeons[0]!.rooms[0]!.objects.find((value) => value.id === "door-e")!;
    object.prefabId = "missing_prefab";
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();
    expect(await screen.findByRole("heading", { name: /Objects · 1/u })).toBeTruthy();
    fireEvent.click(screen.getByTitle("Jump to this on the canvas"));
    expect(screen.getByRole("tab", { name: "Selected" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("ID · door-e")).toBeTruthy();
    expect(document.querySelector(".dungeon-no-art.selected")).toBeTruthy();
  });

  it("collapses identical validation rows while preserving totals and technical paths", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons[0]!;
    const trigger = dungeon.triggers[0]!;
    dungeon.triggers.push(structuredClone(trigger), structuredClone(trigger));
    renderUi(<DungeonStudio api={studioApi(catalog)} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} />);
    await enableAdvanced();

    const validation = await screen.findByRole("region", { name: "Dungeon validation issues" });
    expect(validation.textContent).toContain("2 issues");
    expect(validation.textContent).toContain("Logic · 2");
    expect(validation.textContent).toContain("×2");
    expect(validation.querySelectorAll("li")).toHaveLength(1);
    expect(validation.querySelectorAll("code")).toHaveLength(2);
    expect(validation.querySelectorAll("button")).toHaveLength(1);
  });
});

const session: StudioSession = {
  csrfToken: "csrf",
  origin: "http://127.0.0.1:5285",
  workspace: {
    repositoryPath: "C:/repo",
    worktreePath: "C:/worktrees/dungeon-studio__t824",
    branch: "feature/dungeon-studio--from-t824",
    commitSha: "a".repeat(40),
    writesAllowed: true,
    writeBlockReason: null,
    catalogRevision: 1,
    isLinkedWorktree: true,
    compatibility: {
      contractVersion: 20,
      supportedContractVersion: 20,
      minimumDesktopVersion: "1.20.0",
      compatible: true
    }
  },
  server: {
    pid: 1,
    worktreePath: "C:/worktrees/dungeon-studio__t824",
    branch: "feature/dungeon-studio--from-t824",
    commitSha: "a".repeat(40),
    port: 25285,
    startedAt: new Date(0).toISOString()
  }
};

const publications = new WeakMap<StudioApi, { view: DungeonCatalog; tokens: string[] }[]>();

/** The dungeon-shaped catalog the first (or, with `index`, nth) Save published. */
function publishedView(api: StudioApi, index = 0): DungeonCatalog { return publications.get(api)![index]!.view; }
function publishedTokens(api: StudioApi, index = 0): string[] { return publications.get(api)![index]!.tokens; }

function studioApi(sourceCatalog: DungeonCatalog = DUNGEON_CATALOG): StudioApi {
  // Converted on first use: several tests keep editing the source catalog after building the double.
  let converted: InteriorCatalog | null = null;
  const currentInterior = (): InteriorCatalog => {
    if (!converted) {
      const { spaces, library: contribution } = fromDungeonCatalog(sourceCatalog);
      converted = { library: mergeInteriorLibrary([contribution], sourceCatalog.catalogRevision), spaces };
    }
    return converted;
  };
  const snapshotOf = (value: InteriorCatalog) => ({
    catalogRevision: value.library.catalogRevision,
    library: value.library,
    spaces: value.spaces,
    spaceRevisions: Object.fromEntries(value.spaces.map((space) => [space.id, space.revision]))
  });
  const recorded: { view: DungeonCatalog; tokens: string[] }[] = [];
  const api = {
    loadInteriorCatalog: vi.fn(async () => structuredClone(snapshotOf(currentInterior()))),
    publishInteriorSpace: vi.fn(async (input: { space: InteriorCatalog["spaces"][number]; alsoSpaces?: InteriorCatalog["spaces"]; library?: InteriorCatalog["library"]; pendingAssetTokens?: string[] }) => {
      const interior = currentInterior();
      const changed = [input.space, ...(input.alsoSpaces ?? [])];
      const nextSpaces = interior.spaces.map((space) => changed.find((candidate) => candidate.id === space.id) ?? space);
      for (const added of changed) if (!nextSpaces.some((space) => space.id === added.id)) nextSpaces.push(added);
      const next: InteriorCatalog = { library: { ...(input.library ?? interior.library), catalogRevision: interior.library.catalogRevision + 1 }, spaces: nextSpaces };
      recorded.push({ view: interiorEditingView(next), tokens: input.pendingAssetTokens ?? [] });
      return { ...snapshotOf(next), modifiedFiles: ["packages/shared/src/data/interiors/_library.json"] };
    }),
    loadBossCatalog: vi.fn(async () => { throw new Error("no boss catalog"); }),
    loadRuntimeAssets: vi.fn(async () => ({ assets: [] })),
    importDungeonPng: vi.fn(async (_file: File, options: { prefabId: string }) => ({ stagingToken: "dungeon-art-token", assetKey: `apps/client/public/assets/dungeons/custom/${options.prefabId}.png`, relativeFile: `apps/client/public/assets/dungeons/custom/${options.prefabId}.png`, width: 32, height: 48, bytes: 100, contentHash: "a".repeat(64) })),
    discardDungeonAssets: vi.fn(async () => undefined)
  } as unknown as StudioApi;
  publications.set(api, recorded);
  return api;
}

function catalogWithEmptyDraftDungeon(): DungeonCatalog {
  const catalog = structuredClone(DUNGEON_CATALOG);
  const dungeon = createDungeonFromWizard(catalog, {
    name: "La Granja",
    themeId: "stone",
    backgroundColor: "#071116",
    floorColor: "#182a2d",
    wallColor: "#405052",
    accentColor: "#8fbc8f",
    instancePolicy: "party_ephemeral",
    resetPolicy: "when_empty",
    width: 1440,
    height: 1080
  });
  const room = dungeon.rooms[0]!;
  room.zones.push(
    { id: "encounter_boundary", retired: false, kind: "rectangle", purpose: "encounter_boundary", x: 40, y: 40, width: 1360, height: 1000 },
    { id: "leash", retired: false, kind: "rectangle", purpose: "leash", x: 60, y: 60, width: 1320, height: 960 }
  );
  dungeon.encounters.push({
    id: "la_granja_encounter",
    retired: false,
    name: "La Granja Encounter",
    roomId: room.id,
    boundaryZoneId: "encounter_boundary",
    leashZoneId: "leash",
    waves: [{ id: "wave_1", mobSpawnIds: [], delayMs: 0 }],
    completion: "all_spawned_mobs_defeated",
    reset: { onPartyWipe: true, delayMs: 1500 },
    retry: { allowed: true, maxAttempts: null },
    lockPortalIds: []
  });
  catalog.dungeons.push(dungeon);
  return catalog;
}

function catalogWithMobDeletionFixture(options: { trigger?: boolean; summonedAdd?: boolean }): DungeonCatalog {
  const catalog = catalogWithEmptyDraftDungeon();
  const dungeon = catalog.dungeons.find((value) => value.id === "la_granja")!;
  const room = dungeon.rooms[0]!;
  const encounter = dungeon.encounters[0]!;
  const leaderAnchorId = "deletion_leader_anchor";
  room.anchors.push({ id: leaderAnchorId, retired: false, x: 400, y: 400 });
  room.mobs.push({ id: "deletion_leader", retired: false, archetype: "goblin", anchorId: leaderAnchorId,
    facing: 0, encounterId: encounter.id, spawnGroupId: "deletion_leader", waveIndex: 1, visualScale: 1,
    leashZoneId: encounter.leashZoneId });
  encounter.waves[0]!.mobSpawnIds.push("deletion_leader");
  if (options.summonedAdd) {
    const addAnchorId = "deletion_add_anchor";
    room.anchors.push({ id: addAnchorId, retired: false, x: 500, y: 400 });
    room.mobs.push({ id: "deletion_add", retired: false, archetype: "orc_brute", anchorId: addAnchorId,
      facing: 0, encounterId: encounter.id, spawnGroupId: "deletion_add", waveIndex: 1, visualScale: 1,
      leashZoneId: encounter.leashZoneId, summonedByMobSpawnId: "deletion_leader", summonAtHealthPercent: 50 });
    encounter.waves[0]!.mobSpawnIds.push("deletion_add");
  }
  if (options.trigger) dungeon.triggers.push({ id: "deletion_start", retired: false, enabled: true, scope: "instance", repetition: "once", cooldownMs: 0,
    event: { type: "room_enter", roomId: room.id }, conditions: { mode: "all", items: [] }, actions: [{ type: "start_encounter", encounterId: encounter.id }] });
  return catalog;
}

function addWalkMob(catalog: DungeonCatalog, id: string, x: number, y: number): void {
  const room = catalog.dungeons[0]!.rooms[0]!;
  const anchorId = `${id}_anchor`;
  room.anchors.push({ id: anchorId, retired: false, x, y });
  room.mobs.push({
    id,
    retired: false,
    archetype: "goblin",
    anchorId,
    facing: 0,
    encounterId: "entrance_patrol",
    spawnGroupId: id,
    waveIndex: 1,
    visualScale: 1
  });
}


function recoveryStorageKey(): string {
  return `ash-atlas-interior-studio-draft:${encodeURIComponent(`${session.workspace.worktreePath}|${session.workspace.branch}`)}`;
}

function firePointer(target: Element, type: string, pointerId: number, clientX: number, clientY: number, pointerType = ""): void {
  fireEvent(target, pointerEvent(type, pointerId, clientX, clientY, pointerType));
}

function prefabArt(assetSuffix: string): SVGGElement {
  return Array.from(document.querySelectorAll<SVGImageElement>(".dungeon-prefab-art image"))
    .find((image) => image.getAttribute("href")?.endsWith(assetSuffix))!
    .closest<SVGGElement>(".dungeon-prefab-art")!;
}

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number, pointerType = ""): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    button: { value: 0 },
    isPrimary: { value: true },
    pointerType: { value: pointerType }
  });
  return event;
}
