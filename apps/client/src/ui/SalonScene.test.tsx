// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_FACE_APPEARANCE_ID,
  SALON_CHAIR,
  SALON_DOOR,
  SALON_SPAWN
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SalonMovementTimeline } from "../movement/salonMovementTimeline.js";

vi.mock("./SalonPlayerLayer.js", () => ({
  SalonPlayerLayer: () => <div data-testid="salon-player" />,
  SalonPlayerPreview: ({ appearance }: {
    appearance?: { styles?: Record<string, string | null> };
  }) => <div
    data-testid="salon-preview"
    data-styles={JSON.stringify(appearance?.styles ?? {})}
  />
}));

import { SalonScene } from "./SalonScene.js";

afterEach(cleanup);

function timeline(): SalonMovementTimeline {
  const value = new SalonMovementTimeline();
  value.start("session-1", {
    x: SALON_SPAWN.x,
    y: SALON_SPAWN.y,
    targetX: null,
    targetY: null,
    moving: false,
    revision: 0
  }, 0, 1_000, 0);
  return value;
}

const baseProps = {
  session: {
    structureId: "salon-1",
    sessionId: "session-1",
    position: {
      x: SALON_SPAWN.x,
      y: SALON_SPAWN.y,
      targetX: null,
      targetY: null,
      moving: false,
      revision: 0
    },
    movementSequence: 0,
    displayColor: null
  },
  timeline: timeline(),
  editor: null,
  disabled: false,
  movementDisabled: false,
  saving: false,
  customizing: false,
  error: null,
  layout: "desktop" as const,
  onMove: vi.fn(),
  onCustomize: vi.fn(),
  onSave: vi.fn(),
  onCancelEditor: vi.fn(),
  onExit: vi.fn()
};

describe("SalonScene", () => {
  it("ignores a single floor click and moves on double-click", () => {
    const move = vi.fn();
    const view = render(<SalonScene {...baseProps} timeline={timeline()} onMove={move} />);
    expect(view.container.querySelector(".salon-scene.indoor-scene-viewport")).toBeTruthy();
    expect(view.container.querySelector('.salon-room.indoor-scene-stage[data-indoor-view="fit"]')).toBeTruthy();
    const floor = view.container.querySelector(".salon-room") as HTMLElement;
    Object.defineProperty(floor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 500, height: 500 })
    });
    fireEvent.click(floor, { clientX: 250, clientY: 250 });
    expect(move).not.toHaveBeenCalled();
    fireEvent.doubleClick(floor, { clientX: 250, clientY: 250 });
    expect(move).toHaveBeenCalledWith(500, 500);
  });

  it("maps the bordered client box exactly and ignores border movement without clearing selection", () => {
    const move = vi.fn();
    const view = render(<SalonScene {...baseProps} timeline={timeline()} onMove={move} />);
    const floor = view.container.querySelector(".salon-room") as HTMLElement;
    Object.defineProperties(floor, {
      clientLeft: { configurable: true, value: 8 },
      clientTop: { configurable: true, value: 8 },
      clientWidth: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 500 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 10, top: 20, width: 516, height: 516 })
      }
    });
    fireEvent.doubleClick(floor, { clientX: 143, clientY: 403 });
    expect(move).toHaveBeenLastCalledWith(250, 750);

    fireEvent.click(screen.getByRole("button", { name: "Styling chair" }));
    expect(screen.getByRole("complementary", { name: "Styling Chair actions" })).toBeTruthy();
    fireEvent.doubleClick(floor, { clientX: 14, clientY: 278 });
    expect(move).toHaveBeenCalledOnce();
    expect(screen.getByRole("complementary", { name: "Styling Chair actions" })).toBeTruthy();
  });

  it("selects the chair without moving and closes its canonical prompt before action", () => {
    const move = vi.fn();
    const customize = vi.fn();
    render(<SalonScene {...baseProps} timeline={timeline()} onMove={move} onCustomize={customize} />);
    fireEvent.click(screen.getByRole("button", { name: "Styling chair" }));
    expect(move).not.toHaveBeenCalled();
    expect(within(screen.getByRole("complementary", { name: "Styling Chair actions" }))
      .getByText("SALON")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Customize Appearance" }));
    expect(customize).toHaveBeenCalledOnce();
    expect(screen.queryByRole("complementary", { name: "Styling Chair actions" })).toBeNull();
  });

  it("routes the door through the canonical portal prompt", () => {
    const exit = vi.fn();
    render(<SalonScene {...baseProps} timeline={timeline()} onExit={exit} />);
    fireEvent.click(screen.getByRole("button", { name: "Salon door" }));
    expect(screen.getByText("PORTAL")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave Salon" }));
    expect(exit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("complementary", { name: "Salon Door actions" })).toBeNull();
  });

  it("uses the canonical app shell for the responsive appearance editor", () => {
    const view = render(<SalonScene
      {...baseProps}
      timeline={timeline()}
      layout="phone"
      editor={{
        editorSessionId: "editor-1",
        releaseSha: null,
        catalogRevision: 1,
        schemaVersion: 1,
        appearanceRevision: 1,
        styles: {}
      }}
    />);
    expect(screen.getByText("Choose Your Look")).toBeTruthy();
    expect(screen.queryByText("Salon styles are free and apply to your canonical character.")).toBeNull();
    expect(screen.queryByText("Character Preview")).toBeNull();
    expect(screen.queryByText("LIVE")).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["Hair", "Eyes", "Nose", "Mouth", "Beard", "Legs", "Skin Color"]);
    expect(screen.queryByRole("tab", { name: "Chest" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Hands" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Feet" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Shield" })).toBeNull();
    expect(view.container.querySelector(".game-app-tabs-housed-scrollable")).toBeTruthy();
    expect(screen.getByTestId("salon-preview")).toBeTruthy();
    const previewRegion = screen.getByRole("region", { name: "Character preview" });
    expect(within(previewRegion).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save Style" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const optionsPanel = screen.getByRole("tabpanel", { name: "Hair styles" });
    expect(within(optionsPanel).queryByRole("heading")).toBeNull();
    optionsPanel.scrollTop = 120;
    const scene = view.container.querySelector(".salon-scene.indoor-scene-viewport");
    const editor = view.container.querySelector(".phone-destination-shell.salon-editor-shell");
    expect(scene).toBeTruthy();
    expect(editor).toBeTruthy();
    expect(scene?.contains(editor)).toBe(false);
    expect(view.container.querySelector(".salon-editor")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Eyes" }));
    expect(screen.getByRole("tabpanel", { name: "Eyes styles" }).scrollTop).toBe(0);
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    for (const name of ["Brown", "Blue", "Green", "Grey", "Hazel", "Purple", "Red"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("radio", { name: "Default" })).toBeNull();
    // Legacy eyes have no artist anchor, so they are not movable.
    expect(screen.queryByRole("group", { name: "Move eyes" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Nose" }));
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "None" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Beard" }));
    expect(screen.getByRole("radio", { name: "White Beard" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Black Beard" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Brown Beard" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Skin Color" }));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Medium" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeTruthy();
  });

  it("saves the current draft from the preview overlay", () => {
    const save = vi.fn();
    render(<SalonScene
      {...baseProps}
      timeline={timeline()}
      onSave={save}
      editor={{
        editorSessionId: "editor-1",
        releaseSha: null,
        catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
        schemaVersion: 1,
        appearanceRevision: 1,
        styles: {}
      }}
    />);

    fireEvent.click(screen.getByRole("radio", { name: "Spikey" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Character preview" }))
      .getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({
      eyes: DEFAULT_PLAYER_FACE_APPEARANCE_ID,
      hair: "spikey-hair",
      skinToneId: "light",
      featurePoints: {}
    });
  });

  it("updates the live preview as styles are selected", () => {
    render(<SalonScene
      {...baseProps}
      timeline={timeline()}
      editor={{
        editorSessionId: "editor-1",
        releaseSha: null,
        catalogRevision: 46,
        schemaVersion: 1,
        appearanceRevision: 1,
        styles: {}
      }}
      session={{
        ...baseProps.session,
        appearance: {
          schemaVersion: 1,
          catalogRevision: 46,
          revision: 1,
          bodyVariantId: "default",
          poseId: "idle",
          slots: {},
          styles: {},
          activeHand: null
        }
      }}
    />);

    fireEvent.click(screen.getByRole("tab", { name: "Hair" }));
    fireEvent.click(screen.getByRole("radio", { name: "Spikey" }));
    expect(screen.getByTestId("salon-preview").getAttribute("data-styles"))
      .toContain('"hair":"spikey-hair"');
  });

  it("offers standalone Legs and merges them into the live preview", () => {
    render(<SalonScene
        {...baseProps}
        timeline={timeline()}
        editor={{
          editorSessionId: "editor-1",
          releaseSha: null,
          catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
          schemaVersion: 1,
          appearanceRevision: 1,
          styles: {}
        }}
        session={{
          ...baseProps.session,
          appearance: {
            schemaVersion: 1,
            catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
            revision: 1,
            bodyVariantId: "default",
            poseId: "idle",
            slots: {},
            styles: {},
            activeHand: null
          }
        }}
      />);
    fireEvent.click(screen.getByRole("tab", { name: "Legs" }));
    fireEvent.click(screen.getByRole("radio", { name: "Black Pants" }));
    expect(screen.getByTestId("salon-preview").getAttribute("data-styles"))
      .toContain('"legs":"black-pants"');
  });

  it("preserves the editor's selected Face in the live preview", async () => {
    render(<SalonScene
      {...baseProps}
      timeline={timeline()}
      editor={{
        editorSessionId: "editor-1",
        releaseSha: null,
        catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
        schemaVersion: 1,
        appearanceRevision: 1,
        styles: { eyes: "alternate-face" }
      }}
      session={{
        ...baseProps.session,
        appearance: {
          schemaVersion: 1,
          catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
          revision: 1,
          bodyVariantId: "default",
          poseId: "idle",
          slots: {},
          styles: {},
          activeHand: null
        }
      }}
    />);

    await waitFor(() => {
      expect(screen.getByTestId("salon-preview").getAttribute("data-styles"))
        .toContain('"eyes":"alternate-face"');
    });
  });
});

describe("SalonScene on the map renderer", () => {
  it("opens the Styling Chair prompt from a map tap on the chair and the door prompt from the door", () => {
    const mapPickRef: { current: ((local: { x: number; y: number }) => boolean) | null } = { current: null };
    const customize = vi.fn();
    const view = render(<SalonScene {...baseProps} timeline={timeline()} onCustomize={customize} mapRendered mapPickRef={mapPickRef as never} />);
    expect(view.container.querySelector(".salon-map-hud")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Styling chair" })).toBeNull();
    let handled = false;
    act(() => { handled = mapPickRef.current!(SALON_CHAIR); });
    expect(handled).toBe(true);
    expect(screen.getByRole("complementary", { name: "Styling Chair actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Customize Appearance" }));
    expect(customize).toHaveBeenCalledOnce();
    act(() => { handled = mapPickRef.current!(SALON_DOOR); });
    expect(handled).toBe(true);
    expect(screen.getByRole("button", { name: "Leave Salon" })).toBeTruthy();
    act(() => { handled = mapPickRef.current!({ x: 40, y: 40 }); });
    expect(handled).toBe(false);
  });
});
