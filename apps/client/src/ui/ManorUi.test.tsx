// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  emptyInventoryTotals,
  MANOR_MAIN_ROOM,
  MANOR_SPAWN,
  manorAuthoredRoom,
  manorLobbyStations,
  portalIds,
  type DroppedItemSnapshot,
  type ManorWorldSnapshot
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManorMovementTimeline } from "../movement/manorMovementTimeline.js";
import { MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX } from "../movement/mapMovementInput.js";

vi.mock("./ManorPlayerLayer.js", async () => {
  return {
    ManorPlayerLayer: ({ displayColor }: {
      displayColor: string | null;
    }) => <div data-testid="manor-player-layer" data-color={displayColor ?? ""}/>
  };
});

import { ManorPrompt } from "./ManorPrompt.js";
import { ManorBuildPrompt } from "./ManorBuildPrompt.js";
import { ManorGuestPanel } from "./ManorGuestPanel.js";
import { ManorScene, manorDecorationAssetUrl } from "./ManorScene.js";
import { ManorFoyerScene } from "./ManorFoyerScene.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ownManor: ManorWorldSnapshot = {
  manorId: "manor-a", ownerPlayerId: "a", ownerUsername: "Ash", regionCode: "world-test",
  lat: 35, lon: -106, builtAt: "2026-07-12T00:00:00.000Z", placementRevision: 1
};

function timelineAt(x: number = MANOR_SPAWN.x, y: number = MANOR_SPAWN.y): ManorMovementTimeline {
  const timeline = new ManorMovementTimeline();
  timeline.start("session", { x, y, targetX: null, targetY: null, moving: false, revision: 0 }, 0, 1_000, 0);
  return timeline;
}

const sceneProps = {
  timeline: timelineAt(), displayColor: "#123456", disabled: false, movementDisabled: false,
  occupants: [], ownPlayerId: "a", canKick: true,
  interactionIntent: null,
  onMove: vi.fn(), onInteract: vi.fn(), onCancelInteraction: vi.fn(), onKick: vi.fn()
};

const manorDecorationDefinition = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!.decorations[0]!;
const manorDecorations = {
  manorId: "manor-a",
  roomWidth: MANOR_MAIN_ROOM.roomWidth,
  roomHeight: MANOR_MAIN_ROOM.roomHeight,
  definitions: [{ definition: manorDecorationDefinition, ownedQuantity: 2, availableQuantity: 1 }],
  placements: [{
    placementId: "placement-bed",
    definitionId: manorDecorationDefinition.id,
    itemId: manorDecorationDefinition.itemId,
    itemVariant: null,
    roomId: manorDecorationDefinition.roomId,
    surfaceId: manorDecorationDefinition.surfaceId,
    transform: { ...manorDecorationDefinition.transform }
  }]
};

function installManorPointerEvent(): void {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "";
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
}

function prepareManorFloor(view: { container: HTMLElement }): HTMLElement {
  installManorPointerEvent();
  const floor = view.container.querySelector(".manor-floor") as HTMLElement;
  Object.defineProperty(floor, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: MANOR_MAIN_ROOM.roomWidth, height: MANOR_MAIN_ROOM.roomHeight })
  });
  Object.defineProperty(floor, "setPointerCapture", { configurable: true, value: vi.fn() });
  return floor;
}

function prepareManorShell(
  view: { container: HTMLElement },
  initialBounds: { width: number; height: number }
): { shell: HTMLElement; setBounds(next: { width: number; height: number }): void } {
  const shell = view.container.querySelector(".manor-stage-shell") as HTMLElement;
  let bounds = { ...initialBounds };
  Object.defineProperty(shell, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, ...bounds })
  });
  return {
    shell,
    setBounds(next) {
      bounds = { ...next };
    }
  };
}

const promptProps = {
  jumping: false,
  entering: false,
  destroying: false,
  disabled: false,
  canEnter: true,
  entryDisabledReason: null,
  error: null,
  onJump: vi.fn(),
  onEnter: vi.fn(),
  onManage: vi.fn(),
  onDestroy: vi.fn(),
  onClose: vi.fn()
};

describe("manor interaction prompts", () => {
  it("resolves shared Manor catalog PNGs through the live client asset roots", () => {
    expect(manorDecorationAssetUrl(
      "apps/client/public/assets/manor/simpledoublebed.png"
    )).toBe(`${import.meta.env.BASE_URL}assets/manor/simpledoublebed.png`);
    expect(manorDecorationAssetUrl(
      "apps/client/src/assets/structures/manor-floor.png"
    )).toBeTruthy();
    expect(manorDecorationAssetUrl("apps/client/src/assets/missing.png")).toBeNull();
  });

  it("is nonmodal, matches the interaction prompt pattern, and requires a deliberate entry click", () => {
    const enter = vi.fn();
    const view = render(<ManorPrompt {...promptProps} open manor={ownManor} ownPlayerId="a" entering={false} destroying={false}
      disabled={false} error={null} onEnter={enter} onDestroy={vi.fn()} onClose={vi.fn()}/>);
    expect(view.container.querySelector(".interaction-prompt")).toBeTruthy();
    expect(view.container.querySelector(".modal-scrim")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter Manor" }));
    expect(enter).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Travel to Manor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage Manor" })).toBeTruthy();
  });

  it("shows owner destroy confirmation and preserves storage in its warning", () => {
    const destroy = vi.fn();
    render(<ManorPrompt {...promptProps} open manor={ownManor} ownPlayerId="a" entering={false} destroying={false}
      disabled={false} error={null} onEnter={vi.fn()} onDestroy={destroy} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Destroy Manor" }));
    expect(screen.getByText(/Stored items are preserved/i)).toBeTruthy();
    expect(destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Destroy" }));
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("gives nonowners only owner information and Cancel", () => {
    render(<ManorPrompt {...promptProps} open manor={ownManor} ownPlayerId="b" entering={false} destroying={false}
      disabled={false} canEnter={false} entryDisabledReason="No manor access" error={null} onEnter={vi.fn()} onDestroy={vi.fn()} onClose={vi.fn()}/>);
    expect(screen.getByText("Ash's Manor")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Enter Manor" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Destroy Manor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("closes on Cancel and Escape without a focus trap", () => {
    const close = vi.fn();
    const view = render(<ManorPrompt {...promptProps} open manor={ownManor} ownPlayerId="a" entering={false} destroying={false}
      disabled={false} error={null} onEnter={vi.fn()} onDestroy={vi.fn()} onClose={close}/>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("[aria-modal]")).toBeNull();
  });

  it("uses the canonical compact elevated confirmation for building", () => {
    const build = vi.fn();
    const close = vi.fn();
    const view = render(<ManorBuildPrompt open busy={false} disabled={false} error={null} onBuild={build} onClose={close}/>);
    expect(view.container.querySelector(".game-compact-prompt.game-compact-prompt-elevated")).toBeTruthy();
    expect(screen.getByText("Build Manor Here?")).toBeTruthy();
    expect(view.container.querySelector(".game-compact-category")).toBeNull();
    expect(view.container.querySelector(".game-compact-heading p")).toBeNull();
    expect(view.container.querySelector(".modal-scrim")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Build Manor" }));
    expect(build).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves disabled, error, and busy behavior in the canonical Manor build confirmation", () => {
    const close = vi.fn();
    const view = render(<ManorBuildPrompt open busy={false} disabled error={null} onBuild={vi.fn()} onClose={close}/>);
    expect(screen.queryByRole("button", { name: "Build Manor" })).toBeNull();
    expect(screen.getByText("Reconnect to build a Manor.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.container.querySelector(".game-compact-heading p")).toBeNull();

    view.rerender(<ManorBuildPrompt open busy disabled={false} error="The manor site is blocked." onBuild={vi.fn()} onClose={close}/>);
    expect(screen.getByText("The manor site is blocked.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Build Manor" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(view.container.querySelector(".game-compact-category")).toBeNull();
  });
});

describe("manor scene", () => {
  it("contains no private Manor prompt implementation or raw prompt markup", () => {
    const source = readFileSync(join(process.cwd(), "src", "ui", "ManorScene.tsx"), "utf8");
    expect(source).not.toContain("ManorActionPrompt");
    expect(source).not.toContain("interaction-prompt");
    expect(source).not.toContain("MobileWorldActionSheet");
    expect(source).toContain("GameActionPrompt");
  });

  it("ignores a single floor click and sends one move for a double-click", () => {
    const move = vi.fn();
    const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move}/>);
    const floor = view.container.querySelector(".manor-floor") as HTMLElement;
    Object.defineProperty(floor, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 500, height: 500 }) });
    fireEvent.click(floor, { clientX: 250, clientY: 250 });
    expect(move).not.toHaveBeenCalled();
    fireEvent.doubleClick(floor, { clientX: 250, clientY: 250 });
    expect(move).toHaveBeenCalledWith(MANOR_MAIN_ROOM.roomWidth / 2, MANOR_MAIN_ROOM.roomHeight / 2);
    expect(move).toHaveBeenCalledOnce();
  });

  it("arbitrates two standalone floor clicks before the native double-click", () => {
    vi.useFakeTimers();
    try {
      const move = vi.fn();
      const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move}/>);
      const floor = prepareManorFloor(view);
      fireEvent.click(floor, { button: 0, clientX: 250, clientY: 250 });
      expect(move).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(80); });
      fireEvent.click(floor, { button: 0, clientX: 258, clientY: 255 });
      expect(move).toHaveBeenCalledOnce();
      fireEvent.doubleClick(floor, { button: 0, clientX: 258, clientY: 255 });
      expect(move).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the shared indoor double-tap path for touch movement", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    try {
      const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move}/>);
      const floor = prepareManorFloor(view);
      fireEvent.pointerDown(floor, { pointerId: 31, pointerType: "touch", clientX: 120, clientY: 140 });
      fireEvent.pointerUp(floor, { pointerId: 31, pointerType: "touch", clientX: 120, clientY: 140 });
      fireEvent.click(floor, { clientX: 120, clientY: 140 });
      expect(move).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(80); });
      fireEvent.pointerDown(floor, { pointerId: 32, pointerType: "touch", clientX: 136, clientY: 156 });
      fireEvent.pointerUp(floor, { pointerId: 32, pointerType: "touch", clientX: 126, clientY: 146 });
      fireEvent.click(floor, { clientX: 126, clientY: 146 });
      expect(move).toHaveBeenCalledWith(126 / 1254 * MANOR_MAIN_ROOM.roomWidth, 146 / 1254 * MANOR_MAIN_ROOM.roomHeight);
      fireEvent.doubleClick(floor, { button: 0, clientX: 126, clientY: 146 });
      expect(move).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps realistic touch drift through the shared 14px contact threshold", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    try {
      const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move}/>);
      const floor = prepareManorFloor(view);
      const firstStart = { x: 120, y: 140 };
      const firstEnd = {
        x: firstStart.x + MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX,
        y: firstStart.y
      };
      fireEvent.pointerDown(floor, { pointerId: 41, pointerType: "touch", clientX: firstStart.x, clientY: firstStart.y });
      fireEvent.pointerMove(floor, { pointerId: 41, pointerType: "touch", clientX: firstEnd.x, clientY: firstEnd.y });
      fireEvent.pointerUp(floor, { pointerId: 41, pointerType: "touch", clientX: firstEnd.x, clientY: firstEnd.y });
      act(() => { vi.advanceTimersByTime(80); });
      const secondEnd = { x: firstEnd.x + 8, y: firstEnd.y + 6 };
      fireEvent.pointerDown(floor, { pointerId: 42, pointerType: "touch", clientX: firstEnd.x, clientY: firstEnd.y });
      fireEvent.pointerMove(floor, { pointerId: 42, pointerType: "touch", clientX: secondEnd.x + 1, clientY: secondEnd.y });
      fireEvent.pointerUp(floor, { pointerId: 42, pointerType: "touch", clientX: secondEnd.x, clientY: secondEnd.y });
      expect(move).toHaveBeenCalledWith(
        secondEnd.x / 1254 * MANOR_MAIN_ROOM.roomWidth,
        secondEnd.y / 1254 * MANOR_MAIN_ROOM.roomHeight
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a touch contact after it drifts beyond the shared 14px threshold", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    try {
      const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move}/>);
      const floor = prepareManorFloor(view);
      fireEvent.pointerDown(floor, { pointerId: 51, pointerType: "touch", clientX: 220, clientY: 200 });
      fireEvent.pointerMove(floor, {
        pointerId: 51,
        pointerType: "touch",
        clientX: 220 + MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX + 1,
        clientY: 200
      });
      fireEvent.pointerUp(floor, {
        pointerId: 51,
        pointerType: "touch",
        clientX: 220 + MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX + 1,
        clientY: 200
      });
      act(() => { vi.advanceTimersByTime(160); });
      expect(move).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses native double-click fallback after an unrecognized touch pointerup", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    try {
      const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move}/>);
      const floor = prepareManorFloor(view);
      fireEvent.pointerDown(floor, { pointerId: 61, pointerType: "touch", clientX: 320, clientY: 280 });
      fireEvent.pointerUp(floor, { pointerId: 61, pointerType: "touch", clientX: 320, clientY: 280 });
      fireEvent.doubleClick(floor, { button: 0, clientX: 320, clientY: 280 });
      expect(move).toHaveBeenCalledWith(320 / 1254 * MANOR_MAIN_ROOM.roomWidth, 280 / 1254 * MANOR_MAIN_ROOM.roomHeight);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders one aggregate Manor floor item and opens the canonical pickup action", () => {
    const move = vi.fn();
    const select = vi.fn();
    const timeline = timelineAt();
    const firstDrop: DroppedItemSnapshot = {
      dropId: "drop-wood-a",
      droppedBy: "a",
      regionCode: "interior:manor:manor-a",
      zoneId: "manor:manor-a:manor_main_room",
      pileId: "manor-pile-wood",
      pileOrder: 0,
      itemId: "wood",
      variant: null,
      quantity: 2_400,
      maxStack: 9_000,
      status: "active",
      lat: 0,
      lon: 0,
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "9999-12-31T23:59:59.999Z",
      pickedUpBy: null,
      pickedUpAt: null,
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 900,
      localY: 400
    };
    const secondDrop = { ...firstDrop, dropId: "drop-wood-b", pileOrder: 1, quantity: 3_000, localX: 930, localY: 440 };
    render(
      <ManorScene
        {...sceneProps}
        manorId="manor-a"
        spaceId="manor_main_room"
        timeline={timeline}
        drops={[firstDrop, secondDrop]}
        canEditDecorations
        onMove={move}
        onSelectDroppedItem={select}
      />
    );
    const item = screen.getByRole("button", { name: "wood ×5400 on Manor floor" });
    expect(item.className).toBe("manor-ground-equipment");
    expect(item.querySelector(".item-artwork")).toBeTruthy();
    fireEvent.click(item);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      dropId: "drop-wood-a",
      quantity: 5_400
    }));
    expect(move).not.toHaveBeenCalled();
  });

  it("leaves Manor floor items observable but inert to guests", () => {
    const move = vi.fn();
    const drop: DroppedItemSnapshot = {
      dropId: "drop-guest-visible",
      droppedBy: "a",
      regionCode: "interior:manor:manor-a",
      zoneId: "manor:manor-a:manor_main_room",
      itemId: "wood",
      variant: null,
      quantity: 1,
      status: "active",
      lat: 0,
      lon: 0,
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "9999-12-31T23:59:59.999Z",
      pickedUpBy: null,
      pickedUpAt: null,
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 900,
      localY: 400
    };
    const view = render(
      <ManorScene
        {...sceneProps}
        manorId="manor-a"
        spaceId="manor_main_room"
        drops={[drop]}
        onMove={move}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "wood on Manor floor" }));
    expect(move).not.toHaveBeenCalled();
    expect(view.container.querySelector(".manor-ground-equipment")).toBeTruthy();
  });

  it("uses shared indoor wheel zoom with a full-out reset for each Manor", () => {
    const view = render(<ManorScene {...sceneProps} manorId="manor-a" spaceId="manor_main_room" />);
    const shell = view.container.querySelector(".manor-stage-shell") as HTMLElement;
    const stage = view.container.querySelector(".indoor-scene-stage") as HTMLElement;
    expect(stage.dataset.indoorScale).toBe("1");
    fireEvent.wheel(shell, { deltaY: -10_000 });
    expect(stage.dataset.indoorScale).toBe("2.1");
    fireEvent.wheel(shell, { deltaY: 10_000 });
    expect(stage.dataset.indoorScale).toBe("1");
    fireEvent.wheel(shell, { deltaY: -10_000 });
    expect(stage.dataset.indoorScale).toBe("2.1");
    view.rerender(<ManorScene {...sceneProps} manorId="manor-b" spaceId="manor_main_room" />);
    expect((view.container.querySelector(".indoor-scene-stage") as HTMLElement).dataset.indoorScale)
      .toBe("1");
  });

  it("pans only after a zoomed drag and clamps to the authored room bounds", () => {
    const move = vi.fn();
    const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move} />);
    const floor = prepareManorFloor(view);
    const { shell } = prepareManorShell(view, { width: 500, height: 400 });
    const stage = view.container.querySelector(".indoor-scene-stage") as HTMLElement;

    fireEvent.wheel(shell, { deltaY: -10_000 });
    fireEvent.pointerDown(floor, {
      pointerId: 71,
      pointerType: "mouse",
      button: 0,
      clientX: 120,
      clientY: 100
    });
    fireEvent.pointerMove(floor, {
      pointerId: 71,
      pointerType: "mouse",
      button: 0,
      clientX: 1_120,
      clientY: 100
    });
    expect(stage.style.transform).toBe("translate(170px, 0px) scale(2.1)");
    fireEvent.pointerUp(floor, {
      pointerId: 71,
      pointerType: "mouse",
      button: 0,
      clientX: 1_120,
      clientY: 100
    });
    fireEvent.click(floor, { button: 0, clientX: 1_120, clientY: 100 });
    expect(move).not.toHaveBeenCalled();
  });

  it("clamps camera pan after reset and viewport resize, centering a fitted axis", () => {
    const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} />);
    const floor = prepareManorFloor(view);
    const preparedShell = prepareManorShell(view, { width: 500, height: 400 });
    const stage = view.container.querySelector(".indoor-scene-stage") as HTMLElement;

    fireEvent.wheel(preparedShell.shell, { deltaY: -10_000 });
    fireEvent.pointerDown(floor, {
      pointerId: 72,
      pointerType: "mouse",
      button: 0,
      clientX: 120,
      clientY: 100
    });
    fireEvent.pointerMove(floor, {
      pointerId: 72,
      pointerType: "mouse",
      button: 0,
      clientX: 1_120,
      clientY: 100
    });
    fireEvent.pointerUp(floor, {
      pointerId: 72,
      pointerType: "mouse",
      button: 0,
      clientX: 1_120,
      clientY: 100
    });
    expect(stage.style.transform).toContain("translate(170px, 0px)");

    preparedShell.setBounds({ width: 800, height: 400 });
    fireEvent(window, new Event("resize"));
    expect(stage.style.transform).toBe("translate(20px, 0px) scale(2.1)");

    fireEvent.wheel(preparedShell.shell, { deltaY: 10_000 });
    expect(stage.dataset.indoorScale).toBe("1");
    expect(stage.style.transform).toBe("scale(1)");
  });

  it("cancels an in-progress camera drag without triggering movement", () => {
    const move = vi.fn();
    const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move} />);
    const floor = prepareManorFloor(view);
    const { shell } = prepareManorShell(view, { width: 500, height: 400 });
    const stage = view.container.querySelector(".indoor-scene-stage") as HTMLElement;
    fireEvent.wheel(shell, { deltaY: -10_000 });
    fireEvent.pointerDown(floor, {
      pointerId: 73,
      pointerType: "mouse",
      button: 0,
      clientX: 120,
      clientY: 100
    });
    fireEvent.pointerMove(floor, {
      pointerId: 73,
      pointerType: "mouse",
      button: 0,
      clientX: 180,
      clientY: 100
    });
    fireEvent.pointerCancel(floor, {
      pointerId: 73,
      pointerType: "mouse",
      button: 0,
      clientX: 180,
      clientY: 100
    });
    fireEvent.click(floor, { button: 0, clientX: 180, clientY: 100 });
    expect(stage.style.transform).toBe("translate(60px, 0px) scale(2.1)");
    expect(move).not.toHaveBeenCalled();
  });

  it("does not render the retired Manor Storage fixture or prompt", () => {
    const interact = vi.fn();
    const cancel = vi.fn();
    render(
      <ManorScene
        {...sceneProps}
        timeline={timelineAt()}
        onInteract={interact}
        onCancelInteraction={cancel}
      />
    );
    expect(screen.queryByRole("button", { name: "Storage chest" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Manor Storage actions" })).toBeNull();
    expect(interact).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["Smithing Station", "Use Smithing", "smith"],
    ["Jewel Station", "Use Jewel Station", "jewel"]
  ] as const)("routes the moved %s visual to its canonical action", (visual, action, kind) => {
    const interact = vi.fn();
    render(<ManorScene {...sceneProps} onInteract={interact}/>);
    fireEvent.click(screen.getByRole("button", { name: visual }));
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(interact).toHaveBeenCalledWith(kind);
  });

  it("does not expose a retired Storage action on phone", () => {
    const view = render(<ManorScene {...sceneProps} layout="phone" timeline={timelineAt()} />);
    expect(view.container.querySelector(".mobile-world-action-sheet")).toBeNull();
    expect(view.container.querySelector(".manor-chest-prompt")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Manor Storage actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Storage chest" })).toBeNull();
  });

  it("leaves through the authored world-exit door, not through a self-tap menu", () => {
    const interact = vi.fn();
    const view = render(
      <ManorScene {...sceneProps} timeline={timelineAt()} onInteract={interact} />
    );
    expect(screen.queryByRole("button", { name: "Your character" })).toBeNull();
    const exit = view.container.querySelector(".manor-world-exit-hotspot") as HTMLElement;
    expect(exit).toBeTruthy();
    fireEvent.click(exit);
    const prompt = screen.getByRole("complementary", { name: `${exit.getAttribute("aria-label")} actions` });
    fireEvent.click(within(prompt).getByRole("button", { name: "Leave Manor" }));
    expect(interact).toHaveBeenCalledWith("door");
    expect(screen.queryByRole("button", { name: "Manor door" })).toBeNull();

    view.rerender(
      <ManorScene
        {...sceneProps}
        interactionIntent={{
          kind: "door",
          phase: "requesting",
          token: 2,
          retryCount: 0,
          minimumMovementSequence: 3
        }}
        onInteract={interact}
      />
    );
    expect(screen.queryByRole("button", { name: "Approaching…" })).toBeNull();
  });

  it("lists every destination of a multi-destination door by its typed label", () => {
    const usePortal = vi.fn(() => true);
    render(<ManorScene {...sceneProps} manorId="manor-a" onUsePortal={usePortal} />);
    fireEvent.click(screen.getByRole("button", { name: "Door" }));
    const prompt = screen.getByRole("complementary", { name: "Door actions" });
    expect(within(prompt).getByRole("button", { name: "Upstairs" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Basement" }));
    expect(usePortal).toHaveBeenCalledWith("manor:manor-a:room:manor_lobby_room:anchor:basement_hallway");
  });

  it("keeps one-tap doors to a single destination labelled with their typed text", () => {
    const usePortal = vi.fn(() => true);
    render(<ManorScene {...sceneProps} manorId="manor-a" spaceId="basement_hallway" onUsePortal={usePortal} />);
    fireEvent.click(screen.getByRole("button", { name: "Stairs" }));
    const prompt = screen.getByRole("complementary", { name: "Stairs actions" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Lobby" }));
    expect(usePortal).toHaveBeenCalledWith("manor:manor-a:room:basement_hallway:return_to_manor");
  });

  it("offers the Decorations HUD button in every Manor room", () => {
    const requestDecorations = vi.fn(() => true);
    render(<ManorScene {...sceneProps} spaceId="upstairs_hallway" onRequestDecorations={requestDecorations} />);
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    expect(requestDecorations).toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Manor Decorations actions" })).toBeTruthy();
  });

  it("leaves through the Manor portal without the immediate shortcut so the player walks to the door", () => {
    const move = vi.fn();
    const interact = vi.fn();
    const usePortal = vi.fn(() => true);
    const view = render(
      <ManorScene
        {...sceneProps}
        manorId="manor-a"
        onMove={move}
        onInteract={interact}
        onUsePortal={usePortal}
      />
    );
    const exit = view.container.querySelector(".manor-world-exit-hotspot") as HTMLElement;
    fireEvent.click(exit);
    // Selecting the door only opens its prompt; nothing leaves yet.
    expect(usePortal).not.toHaveBeenCalled();
    const prompt = screen.getByRole("complementary", { name: `${exit.getAttribute("aria-label")} actions` });
    fireEvent.click(within(prompt).getByRole("button", { name: "Leave Manor" }));
    expect(usePortal).toHaveBeenCalledTimes(1);
    expect(usePortal).toHaveBeenCalledWith(portalIds.manorMainToWorld("manor-a"));
    expect(interact).not.toHaveBeenCalledWith("door");
  });

  it("keeps placed decoration art click-through and limits store/remove to the compact menu", () => {
    const moveDecoration = vi.fn();
    const removeDecoration = vi.fn(() => true);
    const view = render(
      <ManorScene
        {...sceneProps}
        decorations={manorDecorations}
        canEditDecorations
        onMoveDecoration={moveDecoration}
        onRemoveDecoration={removeDecoration}
      />
    );
    const placed = view.container.querySelector(".manor-decoration-runtime") as HTMLElement;
    expect(placed).toBeTruthy();
    expect(placed.getAttribute("aria-hidden")).toBe("true");
    expect(placed.getAttribute("title")).toBeNull();
    expect(placed.className).not.toContain("movable");
    fireEvent.pointerDown(placed, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(placed, { pointerId: 1, clientX: 320, clientY: 320 });
    fireEvent.pointerUp(placed, { pointerId: 1, clientX: 320, clientY: 320 });
    fireEvent.click(placed);
    expect(moveDecoration).not.toHaveBeenCalled();
    expect(removeDecoration).not.toHaveBeenCalled();
    expect(screen.queryByRole("complementary", { name: "Manor Decorations actions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    const prompt = screen.getByRole("complementary", { name: "Manor Decorations actions" });
    expect(prompt.classList.contains("manor-decoration-menu-prompt")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Store SimpleDoubleBed" }));
    expect(removeDecoration).toHaveBeenCalledWith("placement-bed");
  });

  it("renders authored catalog defaults without exposing durable placement controls", () => {
    const view = render(
      <ManorScene
        {...sceneProps}
        decorations={{
          ...manorDecorations,
          definitions: [{ definition: manorDecorationDefinition, ownedQuantity: 1, availableQuantity: 0 }],
          placements: [{ ...manorDecorations.placements[0]!, authoredDefault: true }]
        }}
        canEditDecorations
      />
    );
    const image = view.container.querySelector(".manor-decoration-runtime img") as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.getAttribute("src")).toBe(
      `${import.meta.env.BASE_URL}assets/manor/simpledoublebed.png`
    );
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    expect(screen.getByText("Authored template default")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move SimpleDoubleBed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Store SimpleDoubleBed" })).toBeNull();
  });

  it("keeps many decoration choices in the scrollable menu list while Close stays available", () => {
    const definitions = Array.from({ length: 20 }, (_, index) => ({
      definition: {
        ...manorDecorationDefinition,
        id: `decoration-${index}`,
        itemId: `decorative_item_${index}`,
        name: `Decoration ${index}`
      },
      ownedQuantity: 1,
      availableQuantity: 1
    }));
    const view = render(
      <ManorScene
        {...sceneProps}
        decorations={{ ...manorDecorations, definitions, placements: [] }}
        canEditDecorations
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    expect(view.container.querySelector(".manor-decoration-menu-content")).toBeTruthy();
    expect(view.container.querySelector(".manor-decoration-menu-prompt")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Place Decoration/ })).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("keeps a new placement preview visible beneath confirmation until No or Yes", () => {
    const placeDecoration = vi.fn(() => true);
    const view = render(
      <ManorScene
        {...sceneProps}
        decorations={manorDecorations}
        canEditDecorations
        onPlaceDecoration={placeDecoration}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    fireEvent.click(screen.getByRole("button", { name: "Place SimpleDoubleBed" }));
    const floor = prepareManorFloor(view);
    const beforeDrag = (view.container.querySelector(".manor-decoration-runtime.preview") as HTMLElement).style.cssText;
    fireEvent.pointerDown(floor, { pointerId: 11, pointerType: "mouse", button: 0, isPrimary: true, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(floor, { pointerId: 11, pointerType: "mouse", clientX: 700, clientY: 700 });
    fireEvent.pointerUp(floor, { pointerId: 11, pointerType: "mouse", clientX: 700, clientY: 700 });

    expect(screen.getByText("Place SimpleDoubleBed Here?")).toBeTruthy();
    const confirmedPreview = view.container.querySelector(".manor-decoration-runtime.preview") as HTMLElement;
    expect(confirmedPreview).toBeTruthy();
    expect(confirmedPreview.style.cssText).not.toBe(beforeDrag);
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(view.container.querySelector(".manor-decoration-runtime.preview")).toBeNull();
    expect(placeDecoration).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    fireEvent.click(screen.getByRole("button", { name: "Place SimpleDoubleBed" }));
    const secondBeforeDrag = (view.container.querySelector(".manor-decoration-runtime.preview") as HTMLElement).style.cssText;
    fireEvent.pointerDown(floor, { pointerId: 12, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(floor, { pointerId: 12, clientX: 700, clientY: 700 });
    fireEvent.pointerUp(floor, { pointerId: 12, clientX: 700, clientY: 700 });
    expect(screen.getByText("Place SimpleDoubleBed Here?")).toBeTruthy();
    expect((view.container.querySelector(".manor-decoration-runtime.preview") as HTMLElement).style.cssText)
      .not.toBe(secondBeforeDrag);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(placeDecoration).toHaveBeenCalledWith("simple_double_bed", expect.any(Number), expect.any(Number));
    expect(view.container.querySelector(".manor-decoration-runtime.preview")).toBeNull();
  });

  it("map-rendered: drags the placement preview over the map in room units and confirms it", () => {
    const placeDecoration = vi.fn(() => true);
    const previews: Array<{ x: number; y: number } | null> = [];
    const mapPoints = [{ x: 500, y: 760 }, { x: 560, y: 800 }];
    const onPreview = vi.fn((preview: { position: { x: number; y: number } } | null) => {
      previews.push(preview ? preview.position : null);
    });
    const view = render(
      <ManorScene
        {...sceneProps}
        mapRendered
        // jsdom pointer events carry no client coordinates: the map projection is scripted instead.
        screenToLocal={() => mapPoints.shift() ?? { x: 560, y: 800 }}
        onDecorationPreviewChange={onPreview}
        decorations={manorDecorations}
        canEditDecorations
        onPlaceDecoration={placeDecoration}
      />
    );
    expect(view.container.querySelector(".manor-floor-art"), "the map draws the room").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    fireEvent.click(screen.getByRole("button", { name: "Place SimpleDoubleBed" }));
    const capture = view.container.querySelector("[data-manor-placement-capture]") as HTMLElement;
    expect(capture).toBeTruthy();
    expect(previews.at(-1)).not.toBeNull();
    fireEvent.pointerDown(capture, { pointerId: 21, pointerType: "mouse", button: 0, clientX: 500, clientY: 760 });
    fireEvent.pointerMove(capture, { pointerId: 21, pointerType: "mouse", clientX: 560, clientY: 800 });
    fireEvent.pointerUp(capture, { pointerId: 21, pointerType: "mouse", clientX: 560, clientY: 800 });
    const dragged = previews.at(-1)!;
    expect(Math.abs(dragged.x - 560) + Math.abs(dragged.y - 800), "the preview follows the map point (surface-clamped)").toBeLessThan(400);
    expect(screen.getByText("Place SimpleDoubleBed Here?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(placeDecoration).toHaveBeenCalledWith("simple_double_bed", dragged.x, dragged.y);
    expect(previews.at(-1)).toBeNull();
    expect(view.container.querySelector("[data-manor-placement-capture]")).toBeNull();
  });

  it("map-rendered: map taps open the station, door and world-exit prompts like the DOM buttons", () => {
    const pick: { current: ((local: { x: number; y: number }) => boolean) | null } = { current: null };
    render(<ManorScene {...sceneProps} mapRendered mapPickRef={pick} />);
    const tap = (point: { x: number; y: number }): boolean => {
      let hit = false;
      act(() => { hit = pick.current!(point); });
      return hit;
    };
    const stations = manorLobbyStations();
    expect(tap({ x: stations.smith!.x, y: stations.smith!.y })).toBe(true);
    expect(screen.getByRole("button", { name: "Use Smithing" })).toBeTruthy();
    const room = manorAuthoredRoom("manor_main_room")!;
    const exit = room.worldExit!;
    const exitPoint = exit.polygon
      ? exit.polygon.reduce((sum, p) => ({ x: sum.x + p.x / exit.polygon!.length, y: sum.y + p.y / exit.polygon!.length }), { x: 0, y: 0 })
      : { x: exit.x, y: exit.y };
    expect(tap(exitPoint)).toBe(true);
    expect(screen.queryByRole("button", { name: "Use Smithing" })).toBeNull();
    expect(screen.getByRole("button", { name: exit.label ?? "Leave Manor" })).toBeTruthy();
    expect(tap({ x: 2, y: 2 })).toBe(false);
    expect(screen.queryByRole("button", { name: exit.label ?? "Leave Manor" })).toBeNull();
  });

  it("moves movable placements from the menu and restores the original transform on No", () => {
    const moveDecoration = vi.fn(() => true);
    const view = render(
      <ManorScene
        {...sceneProps}
        decorations={manorDecorations}
        canEditDecorations
        onMoveDecoration={moveDecoration}
      />
    );
    const original = view.container.querySelector(".manor-decoration-runtime") as HTMLElement;
    const originalStyle = original.style.cssText;
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    expect(screen.getByRole("button", { name: "Move SimpleDoubleBed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Store SimpleDoubleBed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move SimpleDoubleBed" }));
    expect(screen.queryByRole("complementary", { name: "Manor Decorations actions" })).toBeNull();

    const floor = prepareManorFloor(view);
    fireEvent.pointerDown(floor, { pointerId: 21, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(floor, { pointerId: 21, clientX: 700, clientY: 700 });
    fireEvent.pointerUp(floor, { pointerId: 21, clientX: 700, clientY: 700 });
    expect(screen.getByText("Move SimpleDoubleBed Here?")).toBeTruthy();
    expect(view.container.querySelector(".manor-decoration-runtime.preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(moveDecoration).not.toHaveBeenCalled();
    expect(view.container.querySelector(".manor-decoration-runtime.preview")).toBeNull();
    expect((view.container.querySelector(".manor-decoration-runtime") as HTMLElement).style.cssText)
      .toBe(originalStyle);

    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    fireEvent.click(screen.getByRole("button", { name: "Move SimpleDoubleBed" }));
    fireEvent.pointerDown(floor, { pointerId: 22, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(floor, { pointerId: 22, clientX: 700, clientY: 700 });
    fireEvent.pointerUp(floor, { pointerId: 22, clientX: 700, clientY: 700 });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(moveDecoration).toHaveBeenCalledWith("placement-bed", expect.any(Number), expect.any(Number));
    expect(view.container.querySelector(".manor-decoration-runtime.preview")).toBeNull();
  });

  it("does not expose Move or Store for permanent authored fixtures", () => {
    const permanentDefinition = {
      ...manorDecorationDefinition,
      id: "permanent-bed",
      placementMode: "permanent" as const
    };
    const view = render(
      <ManorScene
        {...sceneProps}
        decorations={{
          ...manorDecorations,
          definitions: [{ definition: permanentDefinition, ownedQuantity: 1, availableQuantity: 0 }],
          placements: [{ ...manorDecorations.placements[0]!, definitionId: permanentDefinition.id }]
        }}
        canEditDecorations
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Decorations" }));
    expect(screen.queryByRole("button", { name: "Move SimpleDoubleBed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Store SimpleDoubleBed" })).toBeNull();
    expect(screen.getByText("Permanent authored fixture")).toBeTruthy();
    expect(view.container.querySelector(".manor-decoration-runtime")).toBeTruthy();
  });

  it("clears a selected Jewel Station before manual floor movement", () => {
    const move = vi.fn();
    const view = render(<ManorScene {...sceneProps} timeline={timelineAt()} onMove={move} />);
    fireEvent.click(screen.getByRole("button", { name: "Jewel Station" }));
    expect(screen.getByRole("complementary", { name: "Jewel Station actions" })).toBeTruthy();
    const floor = view.container.querySelector(".manor-floor") as HTMLElement;
    Object.defineProperty(floor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 500, height: 500 })
    });
    fireEvent.doubleClick(floor, { clientX: 250, clientY: 250 });
    expect(move).toHaveBeenCalledWith(MANOR_MAIN_ROOM.roomWidth / 2, MANOR_MAIN_ROOM.roomHeight / 2);
    expect(screen.queryByRole("complementary", { name: "Jewel Station actions" })).toBeNull();
  });

  it("lets only the owner select and kick live manor guests", () => {
    const kick = vi.fn(() => true);
    const occupant = {
      playerId: "guest",
      displayName: "Beren",
      displayColor: "#123456",
      accessSource: "PARTY" as const,
      spaceId: "manor_main_room" as const,
      position: {
        x: 430, y: 720, targetX: null, targetY: null, moving: false, revision: 1
      },
      movementSequence: 1
    };
    const view = render(
      <ManorScene {...sceneProps} layout="phone" occupants={[occupant]} onKick={kick} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Beren" }));
    expect(screen.getByText("MANOR GUEST")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Guest" }));
    expect(kick).toHaveBeenCalledWith("guest");

    view.rerender(
      <ManorScene {...sceneProps} layout="phone" occupants={[occupant]} canKick={false} />
    );
    expect(screen.queryByRole("button", { name: "Beren" })).toBeNull();
  });

  it("replaces a Jewel approach with exactly one guest prompt", () => {
    const cancel = vi.fn();
    const occupant = {
      playerId: "guest",
      displayName: "Beren",
      displayColor: "#123456",
      accessSource: "PARTY" as const,
      spaceId: "manor_main_room" as const,
      position: {
        x: 430, y: 720, targetX: null, targetY: null, moving: false, revision: 1
      },
      movementSequence: 1
    };
    const view = render(
      <ManorScene
        {...sceneProps}
        occupants={[occupant]}
        onCancelInteraction={cancel}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Jewel Station" }));
    view.rerender(
      <ManorScene
        {...sceneProps}
        occupants={[occupant]}
        interactionIntent={{
          kind: "jewel",
          phase: "moving",
          token: 1,
          retryCount: 0,
          minimumMovementSequence: 1
        }}
        onCancelInteraction={cancel}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Beren" }));

    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("complementary", { name: "Beren actions" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Jewel Station actions" })).toBeNull();
    expect(view.container.querySelectorAll(".game-action-prompt")).toHaveLength(1);
  });

  it("does not expose guest management to guests", () => {
    const view = render(<ManorScene {...sceneProps} timeline={timelineAt()}/>);
    expect(screen.queryByRole("button", { name: "Manor Guests" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Smithing Station" }));
    expect(screen.getByRole("button", { name: "Use Smithing" })).toBeTruthy();
  });
});

describe("manor foyer prompts", () => {
  const foyerProps = {
    manorId: "manor-a",
    timeline: timelineAt(),
    displayColor: null,
    occupants: [],
    disabled: false,
    movementDisabled: false,
    onMove: vi.fn(),
    onUsePortal: vi.fn()
  };

  it("uses only the canonical prompt source", () => {
    const source = readFileSync(join(process.cwd(), "src", "ui", "ManorFoyerScene.tsx"), "utf8");
    expect(source).toContain("GameActionPrompt");
    expect(source).not.toContain("interaction-prompt");
    expect(source).not.toContain('role="dialog"');
  });

  it("selects without portal travel, supports Cancel, and invokes the selected action", () => {
    const usePortal = vi.fn();
    render(<ManorFoyerScene {...foyerProps} onUsePortal={usePortal} />);
    fireEvent.click(screen.getByRole("button", { name: "Exterior Door" }));
    expect(usePortal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exit Manor" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit Manor" }));
    expect(screen.queryByRole("complementary", { name: "Exterior Door actions" })).toBeNull();
    expect(usePortal).toHaveBeenCalledWith(portalIds.manorFoyerToWorld("manor-a"));

    fireEvent.click(screen.getByRole("button", { name: "Main Hall" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("complementary", { name: "Main Hall Door actions" })).toBeNull();
    expect(usePortal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Main Hall" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter Main Hall" }));
    expect(screen.queryByRole("complementary", { name: "Main Hall Door actions" })).toBeNull();
    expect(usePortal).toHaveBeenCalledWith(portalIds.manorFoyerToMain("manor-a"));
  });

  it("clears the selected doorway before manual floor movement", () => {
    const move = vi.fn();
    const view = render(<ManorFoyerScene {...foyerProps} onMove={move} />);
    fireEvent.click(screen.getByRole("button", { name: "Exterior Door" }));
    const room = view.container.querySelector(".manor-foyer-room") as HTMLElement;
    Object.defineProperty(room, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 500, height: 500 })
    });
    fireEvent.doubleClick(room, { clientX: 250, clientY: 250 });
    expect(move).toHaveBeenCalledWith(500, 500);
    expect(screen.queryByRole("complementary", { name: "Exterior Door actions" })).toBeNull();
  });

  it("requires a double gesture for foyer movement and suppresses a synthetic mouse double-click", () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
      }
    });
    const move = vi.fn();
    const view = render(<ManorFoyerScene {...foyerProps} onMove={move} />);
    const room = view.container.querySelector(".manor-foyer-room") as HTMLElement;
    Object.defineProperty(room, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 500, height: 250 })
    });
    fireEvent.click(room, { clientX: 260, clientY: 145 });
    expect(move).not.toHaveBeenCalled();
    fireEvent.doubleClick(room, { clientX: 260, clientY: 145 });
    expect(move).toHaveBeenLastCalledWith(500, 500);

    move.mockClear();
    const firstTap = createEvent.pointerUp(room, { pointerType: "touch", clientX: 260, clientY: 145 });
    fireEvent(room, firstTap);
    expect(move).not.toHaveBeenCalled();
    const secondTap = createEvent.pointerUp(room, { pointerType: "touch", clientX: 260, clientY: 145 });
    fireEvent(room, secondTap);
    expect(move).toHaveBeenCalledOnce();
    expect(move).toHaveBeenLastCalledWith(500, 500);
    fireEvent.doubleClick(room, { clientX: 260, clientY: 145 });
    expect(move).toHaveBeenCalledOnce();
  });
});

describe("manor guest management", () => {
  it("renders authoritative guests and bans and dispatches owner actions", () => {
    const kick = vi.fn(); const ban = vi.fn(); const unban = vi.fn();
    render(<ManorGuestPanel open disabled={false} snapshot={{
      manorId: "manor-a",
      guests: [
        { playerId: "party", displayName: "Beren", displayColor: "#123456", accessSource: "PARTY" },
        { playerId: "invite", displayName: "Cora", displayColor: null, accessSource: "TRAVEL_INVITE" }
      ],
      bannedPlayers: [
        { playerId: "banned", displayName: "Dain", displayColor: null, createdAt: "2026-07-21T00:00:00.000Z" }
      ]
    }} onKick={kick} onBan={ban} onUnban={unban} onClose={vi.fn()}/>);
    expect(screen.getByText("2 current guests")).toBeTruthy();
    expect(screen.getByText("Party")).toBeTruthy();
    expect(screen.getByText("Travel Invite")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Kick" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Ban" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Unban" }));
    expect(kick).toHaveBeenCalledWith("party");
    expect(ban).toHaveBeenCalledWith("invite");
    expect(unban).toHaveBeenCalledWith("banned");
  });
});
