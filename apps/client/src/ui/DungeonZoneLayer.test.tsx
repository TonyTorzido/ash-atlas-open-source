// @vitest-environment jsdom

import {
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CATALOG,
  dungeonLocalToCombatPosition,
  type CombatEntitySnapshot,
  type DungeonObjectSnapshot,
  type DungeonSnapshot
} from "@ash-atlas/shared";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DungeonZoneLayer, dungeonStageClientPointToCombatPosition } from "./DungeonZoneLayer.js";

vi.mock("./DungeonEntityLayer.js", () => ({
  DungeonEntityLayer: ({ ariaLabel }: { ariaLabel: string }) => (
    <div aria-label={ariaLabel} />
  )
}));

const snapshot: DungeonSnapshot = {
  snapshotKind: "full",
  catalogRevision: DUNGEON_CATALOG.catalogRevision,
  sceneRevision: "test-scene-revision",
  dungeonId: "cistern_warrens",
  dungeonRevision: "cistern-warrens-v1",
  entranceId: "sewer-entrance",
  name: "Cistern Warrens",
  description: "Municipal drainage tunnels.",
  instancePolicy: "shared_persistent",
  portalId: "sewer:sewer-1:world-to-entrance",
  presentation: "hatch",
  assetKey: null,
  sewerId: "sewer-1",
  cityId: "city-1",
  cityName: "Test City",
  sessionId: "session-1",
  instanceId: "sewer:sewer-1",
  spaceId: "hatch_landing",
  roomWidth: 1_000,
  roomHeight: 1_000,
  playerVisualHeight: 35,
  camera: {
    mode: "fixed_center",
    center: { x: 500, y: 500 },
    fitPadding: 0,
    defaultZoom: 1,
    minZoom: 0.5,
    maxZoom: 1.6
  },
  environment: {
    environmentId: "city_hatch_landing",
    visualTreatmentId: null,
    musicAssetKey: null,
    ambienceAssetKey: null,
    backgroundColor: "#071116",
    floorColor: "#182a2d",
    wallColor: "#405052",
    accentColor: "#8fbc8f"
  },
  player: {
    playerId: "player-1",
    name: "Wren",
    displayColor: null,
    x: 62.5,
    y: 150,
    targetX: null,
    targetY: null,
    targetEntityId: null,
    movementSpeed: 130,
    movementRevision: 0,
    currentHealth: 100,
    maxHealth: 100
  },
  occupants: [],
  room: CISTERN_WARRENS_DUNGEON.rooms.find((room) => room.id === "hatch_landing")!,
  prefabs: [...DUNGEON_CATALOG.prefabs],
  enemies: [],
  objects: [],
  telegraphs: [],
  encounters: [],
  triggers: [],
  dungeonFlags: {},
  portalLocks: {},
  completed: false,
  resetDeadline: null,
  cues: [],
  status: "Inside the sewer.",
  serverTime: 1
};

function dungeonObject(
  input: Pick<DungeonObjectSnapshot, "id" | "kind" | "name" | "x" | "y" | "available"> &
    Partial<DungeonObjectSnapshot>
): DungeonObjectSnapshot {
  return {
    state: "idle",
    prefabId: "sewer_door",
    prefabRevision: "sewer-door-v1",
    layerId: "actors",
    interactionRadius: 95,
    rotationDeg: 0,
    opacity: 1,
    flipX: false,
    flipY: false,
    zIndex: 10,
    ...input
  };
}

function combatEntityFor(enemy: DungeonSnapshot["enemies"][number]): CombatEntitySnapshot {
  return {
    entityId: enemy.entityId,
    kind: "mob",
    archetypeKey: enemy.archetype,
    name: enemy.name,
    level: 1,
    regionCode: "interior:sewer:sewer-1",
    zoneId: "interior:sewer:sewer-1:hatch_landing",
    ...dungeonLocalToCombatPosition(enemy.x, enemy.y),
    maxHealth: enemy.maxHealth,
    currentHealth: enemy.currentHealth,
    lifeState: enemy.lifeState,
    activityState: "idle",
    targetEntityId: enemy.targetEntityId,
    revision: 1
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("DungeonZoneLayer", () => {
  it("selects living enemies without floor movement and preserves ability targeting", () => {
    const onMove = vi.fn();
    const onSelectEnemy = vi.fn();
    const onTargetPosition = vi.fn();
    const enemy = { entityId: "goblin-1", spawnId: "spawn", encounterId: "encounter",
      archetype: "goblin" as const, name: "Sewer Goblin", x: 200, y: 200,
      currentHealth: 10, maxHealth: 10, lifeState: "alive" as const,
      targetEntityId: null, visualScale: 1 };
    const props = { snapshot: { ...snapshot, enemies: [enemy] }, drops: [],
      movementDisabled: false, onMove, onSelectEnemy, onTargetPosition,
      onSelectObject: vi.fn(), onSelectDroppedItem: vi.fn(),
      combatEntities: [combatEntityFor(enemy)] };
    const view = render(<DungeonZoneLayer {...props} />);
    const stage = view.container.querySelector(".cistern-warrens-stage") as HTMLElement;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 1000, height: 1000
    } as DOMRect);
    const target = screen.getByRole("button", { name: enemy.name });
    fireEvent.pointerDown(target, { pointerType: "touch" });
    fireEvent.pointerUp(target, { pointerType: "touch" });
    fireEvent.pointerDown(target, { pointerType: "touch" });
    fireEvent.pointerUp(target, { pointerType: "touch" });
    fireEvent.doubleClick(target, { clientX: 200, clientY: 200 });
    fireEvent.click(target);
    expect(onSelectEnemy).toHaveBeenCalledOnce();
    expect(onSelectEnemy).toHaveBeenCalledWith(enemy);
    expect(onMove).not.toHaveBeenCalled();
    view.rerender(<DungeonZoneLayer {...props} targeting />);
    fireEvent.click(target, { clientX: 200, clientY: 200 });
    expect(onTargetPosition).toHaveBeenCalledOnce();
    expect(onSelectEnemy).toHaveBeenCalledOnce();
    view.rerender(<DungeonZoneLayer {...props} />);
    const touch = (type: "pointerDown" | "pointerUp", pointerId: number) => {
      const event = createEvent[type](target, { bubbles: true, clientX: 200, clientY: 200 });
      Object.defineProperties(event, {
        pointerType: { value: "touch" }, pointerId: { value: pointerId }
      });
      fireEvent(target, event);
    };
    touch("pointerDown", 1);
    touch("pointerDown", 2);
    touch("pointerUp", 1);
    touch("pointerUp", 2);
    fireEvent.click(target);
    expect(onSelectEnemy).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("renders the sewer without a top-level exit bypass", () => {
    const html = renderToStaticMarkup(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);

    expect(html).toContain("Cistern Warrens");
    expect(html).toContain("indoor-scene-viewport dungeon-zone");
    expect(html).toContain("indoor-scene-stage dungeon-stage cistern-warrens-stage");
    expect(html).toContain('data-indoor-view="fit"');
    expect(html).toContain('data-indoor-scale="1"');
    expect(html).not.toContain("Exit Sewer");
    expect(html).toContain("Wren and Cistern Warrens occupants");
  });

  it("keeps the dungeon stage free of a redundant instructional or status strip", () => {
    const authored = {
      ...snapshot,
      dungeonId: "orc_cave",
      name: "Grimfang Cavern",
      description: "A fortified cavern claimed by an orc warband.",
      instancePolicy: "party_ephemeral"
    } as DungeonSnapshot & { instancePolicy: "party_ephemeral" };
    const html = renderToStaticMarkup(<DungeonZoneLayer
      snapshot={authored}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);

    expect(html).toContain('aria-label="Grimfang Cavern"');
    expect(html).not.toContain("Party Dungeon");
    expect(html).not.toContain("A fortified cavern claimed by an orc warband.");
    expect(html).not.toContain("Double-click or double-tap");
    expect(html).not.toContain("dungeon-header");
    expect(html).not.toContain("dungeon-status");
    expect(html).toContain("Wren and Grimfang Cavern occupants");
  });

  it("selects the portal object instead of exiting immediately", () => {
    const onSelectObject = vi.fn();
    const onMove = vi.fn();

    render(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        objects: [dungeonObject({
          id: "exit-ladder",
          kind: "portal",
          name: "Exit Ladder",
          x: 62.5,
          y: 150,
          available: true,
          portalId: "sewer:sewer-1:entrance-to-world",
          interactionLabel: "Climb Ladder"
        })]
      }}
      drops={[]}
      movementDisabled={false}
      onMove={onMove}
      onSelectObject={onSelectObject}
      onSelectDroppedItem={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Exit Ladder/i }));

    expect(onSelectObject).toHaveBeenCalledWith(expect.objectContaining({
      kind: "portal", portalId: "sewer:sewer-1:entrance-to-world"
    }));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("lets an unavailable object open its prompt so the reason can be explained", () => {
    const onSelectObject = vi.fn();
    render(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        objects: [dungeonObject({
          id: "blocked-door",
          kind: "portal",
          name: "Blocked Door",
          x: 20,
          y: 150,
          available: false,
          portalId: "sewer:sewer-1:hatch-to-overflow",
          interactionLabel: "Go Deeper"
        })]
      }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={onSelectObject}
      onSelectDroppedItem={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Blocked Door/i }));

    expect(onSelectObject).toHaveBeenCalledOnce();
  });

  it("renders a visible authored presentation for every generic dungeon object kind", () => {
    const kinds: DungeonObjectSnapshot["kind"][] = [
      "portal", "door", "ladder", "chest", "valve", "switch", "shrine",
      "harvestable", "destructible", "npc", "decoration", "exit_ladder"
    ];
    const view = render(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        objects: kinds.map((kind, index) => dungeonObject({
          id: `${kind}-${index}`,
          kind,
          name: `Object ${index}`,
          x: 50 + index * 50,
          y: 500,
          available: true
        }))
      }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const buttons = Array.from(view.container.querySelectorAll<HTMLElement>(".dungeon-object"));
    expect(buttons).toHaveLength(kinds.length);
    expect(buttons.every((button) => button.querySelector("img, span") !== null)).toBe(true);
    expect(view.container.textContent).not.toContain("undefined");
  });

  it("projects Studio-authored environment colors into the production stage", () => {
    const view = render(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        environment: {
          ...snapshot.environment,
          backgroundColor: "#010203",
          floorColor: "#111213",
          wallColor: "#212223",
          accentColor: "#313233"
        }
      }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const shell = view.container.querySelector<HTMLElement>(".dungeon-stage-shell")!;
    expect(shell.style.getPropertyValue("--dungeon-background-color")).toBe("#010203");
    expect(shell.style.getPropertyValue("--dungeon-floor-color")).toBe("#111213");
    expect(shell.style.getPropertyValue("--dungeon-wall-color")).toBe("#212223");
    expect(shell.style.getPropertyValue("--dungeon-accent-color")).toBe("#313233");
  });

  it("renders and selects item artwork dropped in the current sewer space", () => {
    const onSelectDroppedItem = vi.fn();
    const onMove = vi.fn();
    const drop = {
      dropId: "drop-1",
      droppedBy: "player-1",
      regionCode: "interior:sewer:sewer-1",
      zoneId: "interior:sewer:sewer-1:hatch_landing",
      pileId: "combat:mob-1:defeat:1",
      pileOrder: 0,
      itemId: "balsam_resin" as const,
      variant: null,
      quantity: 2,
      status: "active" as const,
      lat: 0.0001,
      lon: 0.0001,
      createdAt: "2026-08-08T12:00:00.000Z",
      expiresAt: "2026-08-08T12:10:00.000Z",
      pickedUpBy: null,
      pickedUpAt: null
    };
    render(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[
        drop,
        { ...drop, dropId: "drop-2", pileOrder: 1, quantity: 4 }
      ]}
      movementDisabled={false}
      onMove={onMove}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={onSelectDroppedItem}
    />);

    const markers = screen.getAllByRole("button", { name: /dropped balsam resin/i });
    expect(markers).toHaveLength(1);
    fireEvent.click(markers[0]!);
    expect(onSelectDroppedItem).toHaveBeenCalledWith({ ...drop, quantity: 6 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("renders the exact dropped Enchantment Stone variant artwork", () => {
    const html = renderToStaticMarkup(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[{
        dropId: "gem-drop",
        droppedBy: "player-1",
        regionCode: "interior:sewer:sewer-1",
        zoneId: "interior:sewer:sewer-1:hatch_landing",
        pileId: "gem-pile",
        pileOrder: 0,
        itemId: "enchantment_stone",
        variant: "ruby",
        quantity: 1,
        status: "active",
        lat: 0.0001,
        lon: 0.0001,
        createdAt: "2026-08-08T12:00:00.000Z",
        expiresAt: "2026-08-08T12:10:00.000Z",
        pickedUpBy: null,
        pickedUpAt: null
      }]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);

    expect(html).toMatch(/enchantment-stones\/ruby\.png/);
  });

  it("requires a double gesture for logical sewer movement and moves once for touch", () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      readonly pointerType: string;
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
        this.pointerId = init.pointerId ?? 0;
      }
    });
    const onMove = vi.fn();
    const snapshotWithEnemy = {
      ...snapshot,
      enemies: [{
        entityId: "goblin-1", spawnId: "spawn", encounterId: "encounter",
        archetype: "goblin" as const, name: "Sewer Goblin", x: 700, y: 700,
        currentHealth: 10, maxHealth: 10, lifeState: "alive" as const,
        targetEntityId: null, visualScale: 1
      }]
    };
    const props = {
      snapshot: snapshotWithEnemy,
      drops: [],
      movementDisabled: false,
      onMove,
      onSelectObject: vi.fn(),
      onSelectDroppedItem: vi.fn()
    };
    const view = render(<DungeonZoneLayer {...props} />);
    const stage = view.container.querySelector(".cistern-warrens-stage") as HTMLElement;
    Object.defineProperty(stage, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 320, height: 160 })
    });
    fireEvent.click(stage, { clientX: 170, clientY: 100 });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.doubleClick(stage, { clientX: 170, clientY: 100 });
    expect(onMove).toHaveBeenLastCalledWith(500, 500);

    onMove.mockClear();
    const phoneTap = (pointerId: number): void => {
      fireEvent.pointerDown(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.gotPointerCapture(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.pointerUp(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      // Chromium and mobile Safari normally report capture loss after the up.
      // The completed pointer must not clear the pending first tap.
      fireEvent.lostPointerCapture(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.click(stage, { clientX: 170, clientY: 100 });
    };
    phoneTap(1);
    expect(onMove).not.toHaveBeenCalled();
    phoneTap(2);
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenLastCalledWith(500, 500);
    onMove.mockClear();
    // The same production sequence must continue working after the selected
    // enemy leaves the authoritative snapshot.
    view.rerender(<DungeonZoneLayer {...props} snapshot={{ ...snapshotWithEnemy, enemies: [] }} />);
    phoneTap(3);
    expect(onMove).not.toHaveBeenCalled();
    phoneTap(4);
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenLastCalledWith(500, 500);
    fireEvent.doubleClick(stage, { clientX: 170, clientY: 100 });
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("converts and owns a targeting click against the canonical stage bounds", () => {
    const onMove = vi.fn();
    const onTargetPosition = vi.fn();
    const view = render(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[]}
      movementDisabled={false}
      targeting
      onMove={onMove}
      onTargetPosition={onTargetPosition}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    const bounds = { left: 100, top: 50, width: 400, height: 200 };
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(bounds as DOMRect);

    fireEvent.click(stage, { clientX: 300, clientY: 150 });

    expect(onTargetPosition).toHaveBeenCalledWith(dungeonLocalToCombatPosition(500, 500));
    expect(onMove).not.toHaveBeenCalled();

    onTargetPosition.mockClear();
    fireEvent.doubleClick(stage, { clientX: 300, clientY: 150 });
    expect(onMove).not.toHaveBeenCalled();
    expect(dungeonStageClientPointToCombatPosition({ x: 99, y: 150 }, bounds, 1_000, 1_000)).toBeNull();
  });

  it("uses both rectangular room axes and transformed visible bounds", () => {
    const onMove = vi.fn();
    const rectangular = {
      ...snapshot,
      spaceId: "rectangular_room",
      roomWidth: 1_200,
      roomHeight: 600,
      camera: { ...snapshot.camera, center: { x: 600, y: 300 } },
      objects: [dungeonObject({
        id: "fixture", kind: "valve" as const, name: "Valve",
        x: 300, y: 450, available: true
      })]
    };
    const view = render(<DungeonZoneLayer
      snapshot={rectangular}
      drops={[]}
      movementDisabled={false}
      onMove={onMove}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    expect(stage.style.aspectRatio).toBe("1200 / 600");
    expect(screen.getByRole("button", { name: /Valve/i }).style.left).toBe("25%");
    expect(screen.getByRole("button", { name: /Valve/i }).style.top).toBe("75%");
    Object.defineProperties(stage, {
      clientWidth: { value: 1_200 },
      clientHeight: { value: 600 }
    });
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 50, width: 600, height: 300
    } as DOMRect);
    fireEvent.doubleClick(stage, { clientX: 400, clientY: 200 });
    expect(onMove).toHaveBeenCalledWith(600, 300);
    expect(dungeonStageClientPointToCombatPosition(
      { x: 250, y: 275 },
      { left: 100, top: 50, width: 600, height: 300 },
      1_200,
      600
    )).toEqual(dungeonLocalToCombatPosition(300, 450));
  });

  it("keeps zoom gestures while removing the separate dungeon controls", () => {
    const view = render(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        camera: { ...snapshot.camera, minZoom: 0.9, defaultZoom: 1.05, maxZoom: 1.1 }
      }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    const shell = view.container.querySelector<HTMLElement>(".dungeon-stage-shell")!;
    expect(view.container.querySelector(".dungeon-zoom-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    fireEvent.wheel(view.container.querySelector<HTMLElement>(".dungeon-stage-shell")!, {
      deltaY: -10_000
    });
    expect(stage.dataset.indoorScale).toBe("1.1");
    expect(stage.style.transform).toBe("scale(1.1)");
    expect(stage.style.transform).not.toContain("translate");
    expect(shell).toBeTruthy();
    expect(window.localStorage.getItem("ashAtlas.dungeonZoom.v1")).toBe("1.100");
  });

  it("exposes a recenter reset that restores the canonical dungeon default zoom", () => {
    const onResetZoomReady = vi.fn();
    const view = render(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        camera: { ...snapshot.camera, minZoom: 0.9, defaultZoom: 1.05, maxZoom: 1.2 }
      }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
      onResetZoomReady={onResetZoomReady}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    const resetZoom = onResetZoomReady.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    expect(resetZoom).toEqual(expect.any(Function));

    fireEvent.wheel(view.container.querySelector<HTMLElement>(".dungeon-stage-shell")!, {
      deltaY: -10_000
    });
    expect(stage.dataset.indoorScale).toBe("1.2");
    act(() => { resetZoom!(); });
    expect(stage.dataset.indoorScale).toBe("1.05");
    expect(stage.style.transform).toBe("scale(1.05)");
    expect(window.localStorage.getItem("ashAtlas.dungeonZoom.v1")).toBe("1.050");
  });

  it("clamps the device preference on room changes and never follows the player", () => {
    const view = render(<DungeonZoneLayer
      snapshot={{ ...snapshot, camera: { ...snapshot.camera, defaultZoom: 0.9, maxZoom: 1.1 } }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    fireEvent.wheel(view.container.querySelector<HTMLElement>(".dungeon-stage-shell")!, {
      deltaY: -2_000
    });
    expect(stage.dataset.indoorScale).toBe("1.1");
    view.rerender(<DungeonZoneLayer
      snapshot={{
        ...snapshot,
        spaceId: "narrow_zoom_room",
        camera: { ...snapshot.camera, minZoom: 0.7, defaultZoom: 0.9, maxZoom: 1.1 },
        player: { ...snapshot.player, x: 900, y: 800 }
      }}
      drops={[]}
      movementDisabled={false}
      onMove={vi.fn()}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    expect(stage.dataset.indoorScale).toBe("1.1");
    expect(stage.style.transform).toBe("scale(1.1)");
    expect(stage.style.transform).not.toContain("translate");
  });

  it("suppresses movement taps produced by a pinch gesture", () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      readonly pointerType: string;
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
        this.pointerId = init.pointerId ?? 0;
      }
    });
    const onMove = vi.fn();
    const view = render(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[]}
      movementDisabled={false}
      onMove={onMove}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, width: 320, height: 160
    } as DOMRect);
    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerType: "touch", pointerId: 2, clientX: 240, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 2, clientX: 240, clientY: 100 });
    expect(onMove).not.toHaveBeenCalled();
    expect(stage.dataset.indoorScale).toBe("1.4");

    // Ending a pinch must release gesture suppression immediately; otherwise
    // the next double-tap can remain frozen until a lifecycle reset.
    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 3, clientX: 170, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 3, clientX: 170, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 4, clientX: 170, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 4, clientX: 170, clientY: 100 });
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("clears a cancelled touch and accepts the next complete double tap", () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      readonly pointerType: string;
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
        this.pointerId = init.pointerId ?? 0;
      }
    });
    const onMove = vi.fn();
    const view = render(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[]}
      movementDisabled={false}
      onMove={onMove}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, width: 320, height: 160
    } as DOMRect);

    fireEvent.pointerDown(stage, {
      pointerType: "touch", pointerId: 1, clientX: 170, clientY: 100
    });
    fireEvent.pointerCancel(stage, {
      pointerType: "touch", pointerId: 1, clientX: 170, clientY: 100
    });
    fireEvent.click(stage, { clientX: 170, clientY: 100 });
    expect(onMove).not.toHaveBeenCalled();

    const phoneTap = (pointerId: number): void => {
      fireEvent.pointerDown(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.gotPointerCapture(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.pointerUp(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.lostPointerCapture(stage, {
        pointerType: "touch", pointerId, clientX: 170, clientY: 100
      });
      fireEvent.click(stage, { clientX: 170, clientY: 100 });
    };
    phoneTap(2);
    phoneTap(3);
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenLastCalledWith(500, 500);
  });

  it("clears interrupted gestures across lifecycle changes before accepting fresh movement", () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      readonly pointerType: string;
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "";
        this.pointerId = init.pointerId ?? 0;
      }
    });
    const onMove = vi.fn();
    const view = render(<DungeonZoneLayer
      snapshot={snapshot}
      drops={[]}
      movementDisabled={false}
      onMove={onMove}
      onSelectObject={vi.fn()}
      onSelectDroppedItem={vi.fn()}
    />);
    const stage = view.container.querySelector<HTMLElement>(".dungeon-stage")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, width: 320, height: 160
    } as DOMRect);

    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 2, clientX: 200, clientY: 100 });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pageshow"));
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 2, clientX: 200, clientY: 100 });
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 3, clientX: 170, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 3, clientX: 170, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerType: "touch", pointerId: 4, clientX: 170, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerType: "touch", pointerId: 4, clientX: 170, clientY: 100 });
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenLastCalledWith(500, 500);
  });
});
