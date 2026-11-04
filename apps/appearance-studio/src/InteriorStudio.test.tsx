// @vitest-environment jsdom

import { interiorCatalogFromLegacy, interiorCatalogValidationIssues, type InteriorCatalog } from "@ash-atlas/shared";
import { act, cleanup, createEvent, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./DungeonPlayTest.js", () => ({ DungeonPlayTest: () => <section aria-label="Isolated Play Test" /> }));
vi.mock("pixi.js", () => ({
  Application: class { init(): Promise<void> { return new Promise(() => undefined); } },
  Assets: { load: vi.fn() },
  Container: class { addChild(): void {} },
  Graphics: class {},
  Sprite: class {}
}));
vi.mock("@ash-atlas/player-renderer", () => ({ PixiTextureCache: class {}, PlayerRenderer: class {} }));

import { InteriorStudio, type InteriorStudioHandle } from "./InteriorStudio.js";
import type { StudioSession } from "./bridgeTypes.js";
import { interiorCatalogOf } from "./interiorStudioModel.js";
import type { StudioApi } from "./studioApi.js";

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

const session: StudioSession = {
  csrfToken: "csrf",
  origin: "http://127.0.0.1:5285",
  workspace: {
    repositoryPath: "C:/repo",
    worktreePath: "C:/worktrees/interiors__t1",
    branch: "feature/interiors--from-t1",
    commitSha: "a".repeat(40),
    writesAllowed: true,
    writeBlockReason: null,
    catalogRevision: 1,
    isLinkedWorktree: true,
    compatibility: { contractVersion: 20, supportedContractVersion: 20, minimumDesktopVersion: "1.20.0", compatible: true }
  },
  server: { pid: 1, worktreePath: "C:/worktrees/interiors__t1", branch: "feature/interiors--from-t1", commitSha: "a".repeat(40), port: 25285, startedAt: new Date(0).toISOString() }
};

function snapshotOf(interior: InteriorCatalog) {
  return {
    catalogRevision: interior.library.catalogRevision,
    library: interior.library,
    spaces: interior.spaces,
    spaceRevisions: Object.fromEntries(interior.spaces.map((space) => [space.id, space.revision]))
  };
}

function interiorApi(interior: InteriorCatalog = interiorCatalogFromLegacy(), runtimeAssets: unknown[] = []) {
  const published: unknown[] = [];
  const api = {
    loadInteriorCatalog: vi.fn(async () => structuredClone(snapshotOf(interior))),
    publishInteriorSpace: vi.fn(async (input: { space: InteriorCatalog["spaces"][number]; alsoSpaces?: InteriorCatalog["spaces"]; library?: InteriorCatalog["library"] }) => {
      published.push(input);
      const spaces = interior.spaces.map((space) => [input.space, ...(input.alsoSpaces ?? [])].find((changed) => changed.id === space.id) ?? space);
      for (const added of [input.space, ...(input.alsoSpaces ?? [])]) if (!spaces.some((space) => space.id === added.id)) spaces.push(added);
      const next: InteriorCatalog = { library: { ...(input.library ?? interior.library), catalogRevision: interior.library.catalogRevision + 1 }, spaces };
      return { ...snapshotOf(next), modifiedFiles: ["packages/shared/src/data/interiors/_library.json"] };
    }),
    loadBossCatalog: vi.fn(async () => { throw new Error("no boss catalog"); }),
    discardDungeonAssets: vi.fn(async () => undefined),
    loadRuntimeAssets: vi.fn(async () => ({ assets: runtimeAssets })),
    replaceRuntimeAsset: vi.fn(async (assetId: string) => ({ stagingToken: `token-${assetId.split("/").pop()}`, assetKey: assetId, relativeFile: assetId, width: 64, height: 64, bytes: 10, contentHash: "staged" }))
  };
  return { api: api as unknown as StudioApi, mocks: api, published };
}

function renderStudio(api: StudioApi, extra: { onDirtyChange?: (dirty: boolean) => void; onMessage?: (message: string) => void; handle?: React.RefObject<InteriorStudioHandle | null> } = {}) {
  return renderUi(<InteriorStudio ref={extra.handle} api={api} session={session} visible writesAllowed onDirtyChange={extra.onDirtyChange ?? (() => undefined)} onBusyChange={() => undefined} onMessage={extra.onMessage ?? (() => undefined)} />);
}

const picker = (): HTMLSelectElement => screen.getByLabelText("Interior") as HTMLSelectElement;
const tabNames = (): string[] => within(screen.getByRole("tablist", { name: "Room inspector tasks" })).getAllByRole("tab").map((tab) => tab.textContent ?? "");

async function openSpace(spaceId: string): Promise<void> {
  await screen.findByLabelText("Interior");
  fireEvent.change(picker(), { target: { value: spaceId } });
  await waitFor(() => expect(picker().value).toBe(spaceId));
}

const greenhouseOf = (interior: InteriorCatalog) => interior.spaces.find((space) => space.kind === "greenhouse")!;

describe("Interior Studio workspace", () => {
  it("lists every space grouped by kind and opens on the first dungeon", async () => {
    const { api } = interiorApi();
    renderStudio(api);
    await screen.findByLabelText("Interior");
    const groups = Array.from(picker().querySelectorAll("optgroup")).map((group) => group.label);
    expect(groups).toEqual(["Dungeons", "Manors", "Greenhouse", "Salon"]);
    const interior = interiorCatalogFromLegacy();
    expect(Array.from(picker().querySelectorAll("option")).map((option) => option.value).sort()).toEqual(interior.spaces.map((space) => space.id).sort());
    expect(interior.spaces.find((space) => space.id === picker().value)?.kind).toBe("dungeon");
    expect(screen.getByRole("heading", { name: "Room Tools" })).toBeTruthy();
  });

  it("offers dungeon gameplay tabs only on dungeon spaces", async () => {
    const { api } = interiorApi();
    renderStudio(api);
    await screen.findByLabelText("Interior");
    const dungeonId = picker().value;
    expect(tabNames()).toEqual(["Interior", "Room", "Selected", "Connections", "Enemies", "Resources", "Chests & Loot"]);
    expect(screen.getByRole("tab", { name: /^Flow/u })).toBeTruthy();
    expect((screen.getByRole("tab", { name: "Play Test" }) as HTMLButtonElement).disabled).toBe(false);

    for (const [spaceId, label] of [["manor_lobby", "Manor"], ["greenhouse", "Greenhouse"], ["salon", "Salon"]] as const) {
      await openSpace(spaceId);
      expect(tabNames(), spaceId).toEqual(spaceId === "greenhouse" ? ["Interior", "Room", "Objects & Doors", "Floors & Walls", "Doors & Exits", "Planters", "Layout"] : ["Interior", "Room", "Objects & Doors", "Floors & Walls", "Doors & Exits", "Layout"]);
      expect(screen.getByText(label, { selector: ".dungeon-revision" })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: /^Flow/u })).toBeNull();
      expect(screen.queryByRole("tab", { name: "Simple" })).toBeNull();
      expect((screen.getByRole("tab", { name: "Play Test" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
      expect(screen.getByRole("region", { name: "Interior details" })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: "Mobs" })).toBeNull();
    }
    await openSpace(dungeonId);
    expect(tabNames()).toContain("Enemies");
  });

  it("edits a Manor room, then saves only that space with bumped revisions and its floors kept", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api, mocks, published } = interiorApi(interior);
    const onDirtyChange = vi.fn();
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { onDirtyChange, handle });
    await openSpace("manor_lobby");
    const name = await screen.findByLabelText("Room name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Grand Foyer" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await act(async () => { await handle.current!.save(); });
    expect(mocks.publishInteriorSpace).toHaveBeenCalledTimes(1);
    const request = published[0] as { space: InteriorCatalog["spaces"][number]; alsoSpaces: unknown[]; expectedSpaceRevisions: Record<string, string | null>; expectedCatalogRevision: number; library?: unknown };
    const before = interior.spaces.find((space) => space.id === "manor_lobby")!;
    expect(request.space.id).toBe("manor_lobby");
    expect(request.alsoSpaces).toEqual([]);
    expect(request.library).toBeUndefined();
    expect(request.expectedSpaceRevisions).toEqual({ manor_lobby: before.revision });
    expect(request.expectedCatalogRevision).toBe(interior.library.catalogRevision);
    expect(request.space.revision).not.toBe(before.revision);
    expect(request.space.publishedRevisionId).not.toBe(before.publishedRevisionId);
    expect(request.space.rooms[0]).toMatchObject({ name: "Grand Foyer", floors: before.rooms[0]!.floors, clickAreas: before.rooms[0]!.clickAreas });
    expect(interiorCatalogValidationIssues({ library: interior.library, spaces: interior.spaces.map((space) => space.id === "manor_lobby" ? request.space : space) })).toEqual([]);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect((screen.getByLabelText("Room name") as HTMLInputElement).value).toBe("Grand Foyer");
  });

  it("creates a new interior of a chosen kind and publishes it as a new space", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api, published } = interiorApi(interior);
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { handle });
    await screen.findByLabelText("Interior");
    fireEvent.click(screen.getByRole("button", { name: "+ New interior" }));
    const dialog = screen.getByRole("dialog", { name: "New interior" });
    fireEvent.change(within(dialog).getByLabelText("Interior kind"), { target: { value: "manor" } });
    fireEvent.change(within(dialog).getByLabelText("Interior name"), { target: { value: "Annex" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create interior" }));
    await waitFor(() => expect(picker().value).toBe("annex"));
    expect(tabNames()).toEqual(["Interior", "Room", "Objects & Doors", "Floors & Walls", "Doors & Exits", "Layout"]);
    expect(screen.getByRole("button", { name: "Discard new interior" })).toBeTruthy();
    await act(async () => { await handle.current!.save(); });
    const request = published[0] as { space: InteriorCatalog["spaces"][number]; expectedSpaceRevisions: Record<string, string | null> };
    expect(request.space).toMatchObject({ id: "annex", kind: "manor", publishedRevisionId: "annex-r1" });
    expect(request.expectedSpaceRevisions).toEqual({ annex: null });
    expect(interiorCatalogValidationIssues({ library: interior.library, spaces: [...interior.spaces, request.space] })).toEqual([]);
  });

  it("sends the dungeon wizard for a new dungeon and discards unsaved interiors", async () => {
    const { api } = interiorApi();
    renderStudio(api);
    await screen.findByLabelText("Interior");
    fireEvent.click(screen.getByRole("button", { name: "+ New interior" }));
    const dialog = screen.getByRole("dialog", { name: "New interior" });
    fireEvent.change(within(dialog).getByLabelText("Interior name"), { target: { value: "Cellar" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Dungeon name")).toBeTruthy();

    cleanup();
    const second = interiorApi();
    renderStudio(second.api);
    await screen.findByLabelText("Interior");
    fireEvent.click(screen.getByRole("button", { name: "+ New interior" }));
    fireEvent.change(screen.getByLabelText("Interior kind"), { target: { value: "salon" } });
    fireEvent.change(screen.getByLabelText("Interior name"), { target: { value: "Side Salon" } });
    fireEvent.click(screen.getByRole("button", { name: "Create interior" }));
    await waitFor(() => expect(picker().value).toBe("side_salon"));
    fireEvent.click(screen.getByRole("button", { name: "Discard new interior" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard new interior" }));
    await waitFor(() => expect(Array.from(picker().querySelectorAll("option")).some((option) => option.value === "side_salon")).toBe(false));
  });

  it("recovers an unsaved draft of a non-dungeon space after a reload, keyed by revision", async () => {
    const interior = interiorCatalogFromLegacy();
    const first = interiorApi(interior);
    const view = renderStudio(first.api);
    await openSpace("greenhouse");
    fireEvent.change(await screen.findByLabelText("Room name"), { target: { value: "Recovered Greenhouse" } });
    await waitFor(() => expect(Object.keys(localStorage).some((key) => key.startsWith("ash-atlas-interior-studio-draft:"))).toBe(true));
    view.unmount();

    const onMessage = vi.fn();
    renderStudio(interiorApi(interior).api, { onMessage });
    await screen.findByLabelText("Interior");
    await openSpace("greenhouse");
    expect((await screen.findByLabelText("Room name") as HTMLInputElement).value).toBe("Recovered Greenhouse");
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/Recovered unsaved Interior Studio edits/u));
    cleanup();

    // A draft made against another catalog is offered, not recovered: Restore anyway or Discard old draft.
    const moved = structuredClone(interior);
    moved.library = { ...moved.library, catalogRevision: moved.library.catalogRevision + 1 };
    renderStudio(interiorApi(moved).api);
    await openSpace("greenhouse");
    expect((await screen.findByLabelText("Room name") as HTMLInputElement).value).not.toBe("Recovered Greenhouse");
    const prompt = await screen.findByRole("alertdialog", { name: "Old unsaved draft" });
    expect(within(prompt).getByRole("button", { name: "Restore anyway" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Discard old draft" }));
    expect(Object.keys(localStorage).some((key) => key.startsWith("ash-atlas-interior-studio-draft:"))).toBe(false);
  });

  it("keeps the catalog data intact when only the picker changes", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api } = interiorApi(interior);
    const onDirtyChange = vi.fn();
    renderStudio(api, { onDirtyChange });
    await openSpace("manor_lobby");
    await openSpace("salon");
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(interiorCatalogOf({ ...snapshotOf(interior) }).spaces).toHaveLength(interior.spaces.length);
  });
});

type PublishedRequest = { space: InteriorCatalog["spaces"][number]; alsoSpaces: unknown[] };

function canvasSvg(): SVGSVGElement {
  const svg = document.querySelector<SVGSVGElement>("svg[aria-label$='authoring canvas']")!;
  const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  // One client pixel is one room unit, so pointer coordinates are room coordinates.
  Object.defineProperty(svg, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) });
  return svg;
}
/** jsdom has no PointerEvent, so the generic event gets its coordinates assigned. */
const pointerEvent = (type: "pointerDown" | "pointerUp", x: number, y: number): Event => {
  const event = createEvent[type](canvasSvg(), { pointerId: 1 });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerId: { value: 1 } });
  return event;
};
const clickAt = (x: number, y: number): void => { fireEvent(canvasSvg(), pointerEvent("pointerDown", x, y)); fireEvent(canvasSvg(), pointerEvent("pointerUp", x, y)); };
const openShapes = (): void => { fireEvent.click(screen.getByRole("tab", { name: "Floors & Walls" })); };
const shapeRows = (): string[] => within(screen.getByRole("list", { name: "Shapes in this room" })).queryAllByRole("button").map((button) => button.textContent ?? "");

describe("Interior Studio canvas authoring", () => {
  it("draws a floor and a click area with connected vertices, closing on the first vertex, and saves them", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api, published } = interiorApi(interior);
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { handle });
    await openSpace("manor_lobby");
    openShapes();
    const before = shapeRows();

    fireEvent.click(screen.getByRole("button", { name: "Draw Floor" }));
    clickAt(100, 100); clickAt(400, 100);
    // Two dots cannot close a shape.
    expect((screen.getByRole("button", { name: /Close Shape/u }) as HTMLButtonElement).disabled).toBe(true);
    clickAt(400, 400);
    expect((screen.getByRole("button", { name: /Close Shape/u }) as HTMLButtonElement).disabled).toBe(false);
    clickAt(100, 400);
    // Clicking the first vertex closes the shape.
    clickAt(100, 100);
    await waitFor(() => expect(shapeRows()).toHaveLength(before.length + 1));
    expect(shapeRows().some((row) => /Floor.*floor_surface/u.test(row))).toBe(true);
    expect(screen.getByRole("group", { name: "Polygon vertices" })).toBeTruthy();
    expect(screen.getAllByLabelText(/^Vertex \d X$/u)).toHaveLength(4);

    // A click area binds to an anchor and is closed with the button.
    fireEvent.click(screen.getByRole("button", { name: "Click Area" }));
    clickAt(500, 500); clickAt(600, 500); clickAt(600, 600);
    fireEvent.click(screen.getByRole("button", { name: /Close Shape/u }));
    await waitFor(() => expect(shapeRows().some((row) => /Click area.*click_area/iu.test(row))).toBe(true));
    expect(screen.getByLabelText("Bound to")).toBeTruthy();
    expect(screen.getByLabelText("Interaction label")).toBeTruthy();

    await act(async () => { await handle.current!.save(); });
    const request = published[0] as PublishedRequest;
    const room = request.space.rooms[0]!;
    const stored = interior.spaces.find((space) => space.id === "manor_lobby")!.rooms[0]!;
    expect(room.floors.find((floor) => floor.id === "floor_surface_2")?.polygon).toEqual([{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 400 }, { x: 100, y: 400 }]);
    expect(room.floors.filter((floor) => floor.id !== "floor_surface_2")).toEqual(stored.floors);
    expect(room.clickAreas.find((area) => area.id === "click_area")?.polygon).toHaveLength(3);
    expect(room.clickAreas.length).toBe(stored.clickAreas.length + 1);
    expect(interiorCatalogValidationIssues({ library: interior.library, spaces: interior.spaces.map((space) => space.id === "manor_lobby" ? request.space : space) })).toEqual([]);
  });

  it("cancels a shape with Escape, closes it with Enter, retires the selection with Delete, and undoes each", async () => {
    const { api } = interiorApi();
    renderStudio(api);
    await openSpace("manor_lobby");
    openShapes();
    const before = shapeRows();
    fireEvent.click(screen.getByRole("button", { name: "Collider" }));
    clickAt(100, 100); clickAt(200, 100); clickAt(200, 200);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /Close Shape/u })).toBeNull();
    expect(shapeRows()).toEqual(before);

    fireEvent.click(screen.getByRole("button", { name: "Collider" }));
    clickAt(100, 100); clickAt(200, 100); clickAt(200, 200);
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(shapeRows()).toHaveLength(before.length + 1));

    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(shapeRows()).toEqual(before));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(shapeRows()).toHaveLength(before.length + 1));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(shapeRows()).toEqual(before));
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(shapeRows()).toHaveLength(before.length + 1));
  });

  it("edits vertices in the inspector and snaps drawn vertices to the grid", async () => {
    const { api } = interiorApi();
    renderStudio(api);
    await openSpace("salon");
    openShapes();
    // Snap is off by default; turned on it snaps to the fine 5-unit grid.
    const snap = screen.getByLabelText("Snap") as HTMLInputElement;
    expect(snap.checked).toBe(false);
    fireEvent.click(snap);
    fireEvent.click(screen.getByRole("button", { name: "Wall" }));
    clickAt(113, 112); clickAt(387, 113); clickAt(388, 262);
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(shapeRows().some((row) => /Back wall.*back_wall_surface/iu.test(row))).toBe(true));
    expect((screen.getByLabelText("Vertex 1 X") as HTMLInputElement).value).toBe("115");
    expect((screen.getByLabelText("Vertex 2 X") as HTMLInputElement).value).toBe("385");
    fireEvent.click(snap);
    expect(localStorage.getItem("ash-atlas-interior-studio-snap")).toBe("off");
    fireEvent.change(screen.getByLabelText("Vertex 3 Y"), { target: { value: "300" } });
    expect((screen.getByLabelText("Vertex 3 Y") as HTMLInputElement).value).toBe("300");
    fireEvent.click(screen.getByRole("button", { name: "Add vertex after 3" }));
    expect(screen.getAllByLabelText(/^Vertex \d X$/u)).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Remove vertex 4" }));
    expect(screen.getAllByLabelText(/^Vertex \d X$/u)).toHaveLength(3);
    expect((screen.getByRole("button", { name: "Remove vertex 1" }) as HTMLButtonElement).disabled).toBe(true);
    // Wall image mapping.
    fireEvent.change(screen.getByLabelText("Scale U"), { target: { value: "1.5" } });
    expect((screen.getByLabelText("Scale U") as HTMLInputElement).value).toBe("1.5");
  });

  it("changes an anchor's role and edits its message text", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api, published } = interiorApi(interior);
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { handle });
    await openSpace("salon");
    openShapes();
    fireEvent.click(screen.getByRole("button", { name: "Anchor" }));
    clickAt(300, 300);
    const role = await screen.findByLabelText("Anchor role") as HTMLSelectElement;
    expect(role.value).toBe("point");
    fireEvent.change(role, { target: { value: "message" } });
    const text = await screen.findByLabelText("Message text") as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "The sign is faded." } });
    expect((screen.getByLabelText("Message text") as HTMLTextAreaElement).value).toBe("The sign is faded.");
    await act(async () => { await handle.current!.save(); });
    const anchor = (published[0] as PublishedRequest).space.rooms[0]!.anchors.find((candidate) => candidate.role === "message")!;
    expect(anchor).toMatchObject({ x: 300, y: 300, message: "The sign is faded." });

    // Message text is required: clearing it blocks the save with a visible issue.
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "" } });
    await act(async () => { await handle.current!.save(); });
    expect(published).toHaveLength(1);
    expect((await screen.findAllByText(/message anchor requires message text/u)).length).toBeGreaterThan(0);
  });

  it("pairs a portal anchor with a new anchor in another room, creating both anchors and both portal records", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api, published } = interiorApi(interior);
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { handle });
    await screen.findByLabelText("Interior");
    fireEvent.click(screen.getByRole("button", { name: "+ New interior" }));
    const dialog = screen.getByRole("dialog", { name: "New interior" });
    fireEvent.change(within(dialog).getByLabelText("Interior kind"), { target: { value: "manor" } });
    fireEvent.change(within(dialog).getByLabelText("Interior name"), { target: { value: "Annex" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create interior" }));
    await waitFor(() => expect(picker().value).toBe("annex"));

    // A second room, active so portals may lead there.
    fireEvent.click(screen.getByRole("button", { name: "+ Room" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Create room" })).getByRole("button", { name: "Create room" }));
    await waitFor(() => expect((screen.getByLabelText("Room name") as HTMLInputElement).value).toBe("New Room"));
    fireEvent.click(screen.getByLabelText("Active runtime room"));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Dungeon room graph" })).getByRole("option", { name: /^Annex/u }));

    openShapes();
    fireEvent.click(screen.getByRole("button", { name: "Anchor" }));
    clickAt(300, 300);
    fireEvent.change(await screen.findByLabelText("Anchor role"), { target: { value: "portal" } });
    expect(screen.getByLabelText("Destination room")).toBeTruthy();
    expect((screen.getByLabelText("Button label") as HTMLInputElement).value).toBe("New Room");
    fireEvent.click(screen.getByRole("button", { name: "Save door" }));
    // The new anchor in the other room is selected so it can be dragged onto its doorway.
    await screen.findByRole("region", { name: /^Anchor .*arrival/u });

    await act(async () => { await handle.current!.save(); });
    const space = (published[0] as PublishedRequest).space;
    const [main, other] = space.rooms;
    const exit = space.portals.find((portal) => portal.destination.kind === "world")!;
    const pair = space.portals.filter((portal) => portal !== exit && !portal.retired);
    expect(pair).toHaveLength(2);
    expect(pair[0]!.reciprocalPortalId).toBe(pair[1]!.id);
    expect(pair[1]!.reciprocalPortalId).toBe(pair[0]!.id);
    const created = pair[0]!.destination.kind === "room" ? pair[0]!.destination.anchorId : "";
    expect(other!.anchors.find((anchor) => anchor.id === created)).toMatchObject({ role: "portal" });
    expect(main!.anchors.filter((anchor) => anchor.role === "portal").map((anchor) => anchor.id).sort()).toEqual(["world_exit", pair[0]!.source.kind === "room" ? pair[0]!.source.anchorId : ""].sort());
    expect(interiorCatalogValidationIssues({ library: interior.library, spaces: [...interior.spaces, space] })).toEqual([]);
  });

  it("keeps Simple dungeon mode free of shape tools and its floor automatic", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api } = interiorApi(interior);
    renderStudio(api);
    await screen.findByLabelText("Interior");
    expect(tabNames()).not.toContain("Floors & Walls");
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(tabNames()).toContain("Floors & Walls");
    fireEvent.click(screen.getByRole("tab", { name: "Floors & Walls" }));
    expect(screen.getByText(/automatic floor that follows its size/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Simple" }));
    expect(tabNames()).not.toContain("Floors & Walls");
  });

  it("offers a Walk Test for every kind outside Simple mode and returns to editing", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api } = interiorApi(interior);
    renderStudio(api);
    await openSpace("manor_lobby");
    fireEvent.click(screen.getByRole("tab", { name: "Walk Test" }));
    expect(screen.getByRole("region", { name: "Interior Walk Test" })).toBeTruthy();
    expect(screen.getByLabelText("Floor navigation / collision")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    expect(screen.getByRole("tab", { name: "Floors & Walls" })).toBeTruthy();
    // Simple dungeon mode has no Walk Test.
    await openSpace("cistern_warrens");
    fireEvent.click(screen.getByRole("tab", { name: "Simple" }));
    expect(screen.queryByRole("tab", { name: "Walk Test" })).toBeNull();
  });

  it("edits the Greenhouse Farm Plot template and plant stage art, then publishes the prefab and stage art with a new greenhouse revision", async () => {
    const interior = interiorCatalogFromLegacy();
    const greenhouse = greenhouseOf(interior);
    const potId = greenhouse.modules!.planters!.potPrefabId;
    const { api, published } = interiorApi(interior);
    const onDirtyChange = vi.fn();
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { onDirtyChange, handle });
    await openSpace(greenhouse.id);
    fireEvent.click(screen.getByRole("tab", { name: "Planters" }));
    const plot = screen.getByRole("group", { name: "Farm Plot template" });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    // Footprint and image frame stay centered on the anchor; touch area switches shape.
    fireEvent.change(within(plot).getByLabelText("Footprint W"), { target: { value: "120" } });
    fireEvent.change(within(plot).getByLabelText("Render H"), { target: { value: "200" } });
    fireEvent.change(within(plot).getByLabelText("Anchor X"), { target: { value: "0.4" } });
    fireEvent.change(within(plot).getByLabelText("Touch shape"), { target: { value: "rectangle" } });
    fireEvent.change(within(plot).getByLabelText("Touch W"), { target: { value: "150" } });
    // Stage art of the first plant stage.
    fireEvent.change(screen.getByLabelText("Offset X"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Scale"), { target: { value: "9" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await act(async () => { await handle.current!.save(); });
    expect(published).toHaveLength(1);
    const request = published[0] as { space: InteriorCatalog["spaces"][number]; library: InteriorCatalog["library"]; expectedSpaceRevisions: Record<string, string | null> };
    const pot = request.library.prefabs.find((prefab) => prefab.id === potId)!;
    const before = interior.library.prefabs.find((prefab) => prefab.id === potId)!;
    expect(pot.footprint!.map((point) => Math.abs(point.x))).toEqual([60, 60, 60, 60]);
    expect(pot).toMatchObject({ defaultHeight: 200, pivotX: 0.4, touchArea: { kind: "polygon" } });
    expect(pot.defaultWidth).toBe(before.defaultWidth);
    const art = request.space.modules!.planters!.stageArt.find((entry) => entry.cropId === "wheat" && entry.stage === 1)!;
    expect(art.offsetX).toBe(12);
    expect(art.scale).toBe(4);
    expect(request.space.revision).not.toBe(greenhouse.revision);
    expect(request.expectedSpaceRevisions).toEqual({ [greenhouse.id]: greenhouse.revision });
    expect(interiorCatalogValidationIssues({ library: request.library, spaces: interior.spaces.map((space) => space.id === greenhouse.id ? request.space : space) })).toEqual([]);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("publishes nothing when the Planters tab is opened and nothing is edited", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api, published } = interiorApi(interior);
    const onDirtyChange = vi.fn();
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { handle, onDirtyChange });
    await openSpace("greenhouse");
    fireEvent.click(screen.getByRole("tab", { name: "Planters" }));
    fireEvent.click(screen.getByRole("button", { name: "Middle 2" }));
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    await act(async () => { await handle.current!.save(); });
    expect(published).toHaveLength(0);
  });

  it("stages a replacement Farm Plot PNG, sends its token on Save and discards it on Revert", async () => {
    const interior = interiorCatalogFromLegacy();
    const greenhouse = greenhouseOf(interior);
    const pot = interior.library.prefabs.find((prefab) => prefab.id === greenhouse.modules!.planters!.potPrefabId)!;
    const { api, mocks, published } = interiorApi(interior, [{ id: pot.assetKey, label: "pot", imageUrl: "/runtime-assets/pot.png", width: 64, height: 64, contentHash: "pot", bytes: 10 }]);
    const onDirtyChange = vi.fn();
    const handle = createRef<InteriorStudioHandle>();
    renderStudio(api, { onDirtyChange, handle });
    await openSpace(greenhouse.id);
    fireEvent.click(screen.getByRole("tab", { name: "Planters" }));
    const file = new File([new Uint8Array([137, 80, 78, 71])], "new-plot.png", { type: "image/png" });
    fireEvent.change(within(screen.getByRole("group", { name: "Farm Plot template" })).getByLabelText(/Farm Plot PNG/u), { target: { files: [file] } });
    await waitFor(() => expect(mocks.replaceRuntimeAsset).toHaveBeenCalledWith(pot.assetKey, file));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await act(async () => { await handle.current!.revert(); });
    expect(mocks.discardDungeonAssets).toHaveBeenLastCalledWith([expect.stringContaining("token-")]);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    fireEvent.change(within(screen.getByRole("group", { name: "Farm Plot template" })).getByLabelText(/Farm Plot PNG/u), { target: { files: [file] } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    await act(async () => { await handle.current!.save(); });
    expect(published).toHaveLength(1);
    expect((published[0] as { pendingAssetTokens: string[] }).pendingAssetTokens).toEqual([expect.stringContaining("token-")]);
  });

  describe("Decoration Test", () => {
    const manorOf = (interior: InteriorCatalog) => interior.spaces.find((space) => space.id === "manor_lobby")!;
    const withImport = (interior: InteriorCatalog) => {
      const made = interiorApi(interior);
      (made.mocks as unknown as Record<string, unknown>).importManorPng = vi.fn(async () => ({ stagingToken: "decor-token", assetKey: "apps/client/public/assets/manor/decor_test.png", relativeFile: "x", width: 64, height: 64, bytes: 10, contentHash: "h" }));
      return made;
    };

    it("is offered on Manor spaces only", async () => {
      const { api } = interiorApi();
      renderStudio(api);
      await screen.findByLabelText("Interior");
      expect(screen.queryByRole("tab", { name: "Decoration Test" })).toBeNull();
      await openSpace("greenhouse");
      expect(screen.queryByRole("tab", { name: "Decoration Test" })).toBeNull();
      await openSpace("manor_lobby");
      expect(screen.getByRole("tab", { name: "Decoration Test" })).toBeTruthy();
    });

    it("adds a floor decoration with a staged PNG and publishes it in the Manor space", async () => {
      vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:decoration-preview") }));
      const interior = interiorCatalogFromLegacy();
      const { api, published, mocks } = withImport(interior);
      const handle = createRef<InteriorStudioHandle>();
      const { container } = renderStudio(api, { handle });
      await openSpace("manor_lobby");
      fireEvent.click(screen.getByRole("tab", { name: "Decoration Test" }));
      expect(container.querySelector(".manor-studio")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Add Floor" }));
      const input = container.querySelector<HTMLInputElement>(".manor-studio input[type=file]")!;
      fireEvent.change(input, { target: { files: [new File(["x"], "Fancy Rug.png", { type: "image/png" })] } });
      await waitFor(() => expect((mocks as unknown as { importManorPng: ReturnType<typeof vi.fn> }).importManorPng).toHaveBeenCalled());
      await screen.findByText(/PNG staged/u);
      fireEvent.change(screen.getByLabelText("X"), { target: { value: "400" } });
      await act(async () => { await handle.current!.save(); });
      expect(published).toHaveLength(1);
      const request = published[0] as { space: InteriorCatalog["spaces"][number]; pendingAssetTokens: string[] };
      const definitions = request.space.modules!.decoration!.definitions;
      const added = definitions.find((value) => value.id !== "simple_double_bed")!;
      expect(definitions).toHaveLength(2);
      expect(added).toMatchObject({ name: "Fancy Rug", retired: false, roomId: "manor_lobby_room", surfaceId: "floor_surface", assetKey: "apps/client/public/assets/manor/decor_test.png" });
      expect(added.transform.x).toBe(400);
      expect(request.pendingAssetTokens).toEqual(["decor-token"]);
      expect(request.space.revision).not.toBe(manorOf(interior).revision);
      expect(interiorCatalogValidationIssues({ library: interior.library, spaces: interior.spaces.map((space) => space.id === request.space.id ? request.space : space) })).toEqual([]);
    });

    it("retires a stored decoration on Delete instead of removing it", async () => {
      const interior = interiorCatalogFromLegacy();
      const { api, published } = interiorApi(interior);
      const handle = createRef<InteriorStudioHandle>();
      renderStudio(api, { handle });
      await openSpace("manor_lobby");
      fireEvent.click(screen.getByRole("tab", { name: "Decoration Test" }));
      fireEvent.click(within(screen.getByRole("listbox", { name: "Draft decorations" })).getByRole("option", { name: /SimpleDoubleBed/u }));
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.queryByRole("option", { name: /SimpleDoubleBed/u })).toBeNull();
      await act(async () => { await handle.current!.save(); });
      const request = published[0] as { space: InteriorCatalog["spaces"][number] };
      expect(request.space.modules!.decoration!.definitions).toEqual([expect.objectContaining({ id: "simple_double_bed", retired: true })]);
    });

    it("drops a never-published decoration on Delete and publishes nothing", async () => {
      const interior = interiorCatalogFromLegacy();
      const { api, published } = interiorApi(interior);
      const onDirtyChange = vi.fn();
      renderStudio(api, { onDirtyChange });
      await openSpace("manor_lobby");
      fireEvent.click(screen.getByRole("tab", { name: "Decoration Test" }));
      fireEvent.click(screen.getByRole("button", { name: "Add Floor" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(within(screen.getByRole("listbox", { name: "Draft decorations" })).getAllByRole("option")).toHaveLength(1);
      expect(published).toHaveLength(0);
    });
  });
  it("loads under React StrictMode when the first effect is cleaned up", async () => {
    const interior = interiorCatalogFromLegacy();
    const { api } = interiorApi(interior);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = vi.mocked(api.loadInteriorCatalog).getMockImplementation()!;
    vi.mocked(api.loadInteriorCatalog).mockImplementation(async () => { await gate; return load(); });
    renderUi(<StrictMode><InteriorStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} /></StrictMode>);
    await waitFor(() => expect(api.loadInteriorCatalog).toHaveBeenCalledTimes(2));
    release();
    expect(await screen.findByLabelText("Interior")).toBeTruthy();
  });

});
