// @vitest-environment jsdom

import { interiorCatalogFromLegacy, type InteriorCatalog } from "@ash-atlas/shared";
import { cleanup, createEvent, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
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

import { InteriorStudio } from "./InteriorStudio.js";
import type { StudioSession } from "./bridgeTypes.js";
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
  Object.defineProperty(SVGSVGElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
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
  return { catalogRevision: interior.library.catalogRevision, library: interior.library, spaces: interior.spaces, spaceRevisions: Object.fromEntries(interior.spaces.map((space) => [space.id, space.revision])) };
}

function interiorApi(interior: InteriorCatalog = interiorCatalogFromLegacy()) {
  const api = {
    loadInteriorCatalog: vi.fn(async () => structuredClone(snapshotOf(interior))),
    publishInteriorSpace: vi.fn(async () => ({ ...snapshotOf(interior), modifiedFiles: [] })),
    loadBossCatalog: vi.fn(async () => { throw new Error("no boss catalog"); }),
    discardDungeonAssets: vi.fn(async () => undefined),
    loadRuntimeAssets: vi.fn(async () => ({ assets: [] }))
  };
  return api as unknown as StudioApi;
}

function renderStudio(api: StudioApi, extra: { hosted?: boolean } = {}) {
  return renderUi(<InteriorStudio api={api} session={session} visible writesAllowed onDirtyChange={() => undefined} onBusyChange={() => undefined} onMessage={() => undefined} {...(extra.hosted ? { hosted: true } : {})} />);
}

const picker = (): HTMLSelectElement => screen.getByLabelText("Interior") as HTMLSelectElement;
async function openSpace(spaceId: string): Promise<void> {
  await screen.findByLabelText("Interior");
  fireEvent.change(picker(), { target: { value: spaceId } });
  await waitFor(() => expect(picker().value).toBe(spaceId));
}

describe("Interior Studio hosted toolbar", () => {
  it("leaves Undo, Redo, Revert and Save to the host header", async () => {
    renderStudio(interiorApi(), { hosted: true });
    await screen.findByLabelText("Interior");
    const toolbar = within(screen.getByRole("banner", { name: "Interior toolbar" }));
    for (const name of ["Undo", "Redo", "Revert", "Save to Worktree"]) {
      expect(toolbar.queryByRole("button", { name })).toBeNull();
    }
  });
});

const toolButton = (name: string): HTMLElement => within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name });
const pressed = (name: string): string | null => toolButton(name).getAttribute("aria-pressed");

describe("Interior Studio canvas tools", () => {
  it("arms tools from single-key shortcuts, returns to Select on Escape and ignores keys typed into fields", async () => {
    renderStudio(interiorApi());
    await openSpace("manor_lobby");
    expect(pressed("Select")).toBe("true");
    for (const [key, tool] of [["f", "Draw Floor"], ["w", "Wall"], ["c", "Collider"], ["k", "Click Area"], ["a", "Anchor"], ["h", "Pan"]] as const) {
      fireEvent.keyDown(window, { key });
      expect(pressed(tool), `${key} arms ${tool}`).toBe("true");
      expect(pressed("Select")).toBe("false");
    }
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pressed("Select")).toBe("true");
    fireEvent.keyDown(window, { key: "w" });
    expect(screen.getByRole("group", { name: "Wall side" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "v" });
    expect(pressed("Select")).toBe("true");
    expect(screen.queryByRole("group", { name: "Wall side" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
    const field = screen.getAllByRole("textbox")[0]!;
    fireEvent.keyDown(field, { key: "f" });
    expect(pressed("Draw Floor")).toBe("false");
  });

  it("pans while Space is held and lists the shortcuts behind the ? button", async () => {
    renderStudio(interiorApi());
    await openSpace("manor_lobby");
    fireEvent.keyDown(window, { key: " " });
    expect(pressed("Pan")).toBe("true");
    fireEvent.keyUp(window, { key: " " });
    expect(pressed("Select")).toBe("true");
    fireEvent.keyDown(window, { key: "?" });
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Draw Floor")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("offers only Select, Pan and Place in Simple dungeon mode", async () => {
    renderStudio(interiorApi());
    await screen.findByLabelText("Interior");
    expect(within(screen.getByRole("toolbar", { name: "Canvas tools" })).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Select", "Pan", "Place from library"]);
    fireEvent.keyDown(window, { key: "f" });
    expect(pressed("Select")).toBe("true");
  });

  it("arms Place from library once a library item is chosen and Escape cancels it", async () => {
    renderStudio(interiorApi());
    await openSpace("manor_lobby");
    expect((toolButton("Place from library") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: /Click to place/u })[0]!);
    expect(pressed("Place from library")).toBe("true");
    expect(screen.getAllByRole("status").map((node) => node.textContent).join(" ")).toMatch(/Click the room to place/u);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pressed("Select")).toBe("true");
    // The last pick can be re-armed with P.
    fireEvent.keyDown(window, { key: "p" });
    expect(pressed("Place from library")).toBe("true");
  });
});

function brokenObjectCatalog(): InteriorCatalog {
  const interior = structuredClone(interiorCatalogFromLegacy());
  const room = interior.spaces.find((space) => space.kind === "dungeon")!.rooms.find((value) => value.objects.length > 0)!;
  const object = room.objects[0]!;
  object.prefabId = "missing_prefab";
  const anchor = room.anchors.find((value) => value.id === object.anchorId)!;
  anchor.x = 40;
  anchor.y = 40;
  return interior;
}

describe("Interior Studio validation", () => {
  it("disables Save with a reason, counts errors in the badge and jumps to the offending item on click", async () => {
    Object.defineProperty(SVGSVGElement.prototype, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(SVGSVGElement.prototype, "clientHeight", { configurable: true, value: 600 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
    renderStudio(interiorApi(brokenObjectCatalog()));
    const toolbar = await screen.findByRole("banner", { name: "Interior toolbar" });
    const badge = await within(toolbar).findByRole("button", { name: /^Validation: \d+ errors?/u });
    expect(badge.textContent).toMatch(/^\d+ errors?/u);
    // Save stays disabled while errors exist; the tooltip says why.
    const save = within(toolbar).getByRole("button", { name: "Save to Worktree" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(badge);
    const panel = screen.getByRole("region", { name: "Dungeon validation issues" });
    const row = within(panel).getAllByTitle("Jump to this on the canvas")[0]!;
    const canvas = (): SVGSVGElement => document.querySelector<SVGSVGElement>(".dungeon-stage svg")!;
    expect(canvas().style.transform).toContain("translate(0px, 0px)");
    fireEvent.click(row);
    await waitFor(() => expect(canvas().style.transform).not.toContain("translate(0px, 0px)"));
    expect(screen.getByRole("tab", { name: "Selected" }).getAttribute("aria-selected")).toBe("true");
    const header = screen.getByLabelText("Selected item");
    expect(within(header).getByText(/Door|Chest|Valve|Switch|Shrine|Ladder|Decoration|Character|Harvestable|Destructible|Switch/u)).toBeTruthy();
    expect(screen.queryByText("Select something on the canvas or pick a tool.")).toBeNull();
  });
});

describe("Interior Studio inspector", () => {
  it("shows a friendly empty state on the Selected tab when nothing is selected", async () => {
    renderStudio(interiorApi());
    await screen.findByLabelText("Interior");
    fireEvent.click(screen.getByRole("tab", { name: "Selected" }));
    expect(screen.getByText("Select something on the canvas or pick a tool.")).toBeTruthy();
    expect(screen.queryByLabelText("Selected item")).toBeNull();
  });
});

describe("Interior Studio room checklist", () => {
  it("offers setup steps for a room without art or a drawn floor and ticks art once it exists", async () => {
    const interior = structuredClone(interiorCatalogFromLegacy());
    const manor = interior.spaces.find((space) => space.id === "manor_lobby")!;
    for (const room of manor.rooms) for (const layer of Object.keys(room.layers) as Array<keyof typeof room.layers>) room.layers[layer] = [];
    renderStudio(interiorApi(interior));
    await openSpace("manor_lobby");
    const list = await screen.findByRole("region", { name: "Room setup checklist" });
    expect(within(list).getAllByRole("listitem").map((item) => item.getAttribute("data-done"))).toEqual(["false", "true", "true", "true"]);
    fireEvent.click(within(list).getByRole("button", { name: "Draw the floor" }));
    expect(pressed("Draw Floor")).toBe("true");
    fireEvent.click(within(list).getByRole("button", { name: "Hide checklist" }));
    expect(screen.queryByRole("region", { name: "Room setup checklist" })).toBeNull();
  });

  it("stays out of the way on a finished room", async () => {
    renderStudio(interiorApi());
    await openSpace("manor_lobby");
    expect(screen.queryByRole("region", { name: "Room setup checklist" })).toBeNull();
  });
});
