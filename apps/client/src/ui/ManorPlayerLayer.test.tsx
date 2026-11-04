// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  MANOR_FLOOR_SIZE,
  MANOR_MAIN_ROOM,
  MANOR_SPAWN,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManorMovementTimeline } from "../movement/manorMovementTimeline.js";

const lifecycle = vi.hoisted(() => ({
  constructor: vi.fn(), init: vi.fn(), destroy: vi.fn(), resize: vi.fn(), render: vi.fn(),
  addChild: vi.fn(), positionSet: vi.fn(), scaleSet: vi.fn(), playerRenderer: vi.fn(), parseColor: vi.fn(() => 0xfb7185),
  updateAppearance: vi.fn(async () => undefined), playerDestroy: vi.fn(),
  stop: vi.fn(), tickerStop: vi.fn(), size: { width: 400, height: 300 },
  observerCallbacks: [] as Array<() => void>, frames: [] as FrameRequestCallback[]
}));

vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    screen = { width: 1, height: 1 };
    stage = { addChild: lifecycle.addChild };
    ticker = { stop: lifecycle.tickerStop };
    renderer = {
      resize: (width: number, height: number) => { this.screen = { width, height }; lifecycle.resize(width, height); },
      render: lifecycle.render
    };
    constructor() { lifecycle.constructor(); }
    async init(options: unknown) { lifecycle.init(options); }
    render() { lifecycle.render(); }
    stop() { lifecycle.stop(); }
    start() {}
    destroy(removeView: boolean, options: unknown) { lifecycle.destroy(removeView, options); }
  }
}));

// The Jacket B rig needs real Pixi containers; the layer tests cover lifecycle only.
vi.mock("../players/jacketRig.js", () => ({ createJacketRig: () => null }));

vi.mock("@ash-atlas/player-renderer", () => ({
  PixiTextureCache: class {},
  playerDisplayColorNumber: lifecycle.parseColor,
  PlayerRenderer: class {
    baseHeightPx = 42;
    overallScale = 1;
    walkAnimating = false;
    visualRoot = { visible: true };
    setLocomotion = vi.fn();
    updateAnimation = vi.fn();
    root = {
      position: { set: lifecycle.positionSet },
      scale: { set: lifecycle.scaleSet },
      removeFromParent: vi.fn()
    };
    constructor(...args: unknown[]) { lifecycle.playerRenderer(...args); }
    updateAppearance = lifecycle.updateAppearance;
    destroy = lifecycle.playerDestroy;
  }
}));

import { ManorPlayerLayer } from "./ManorPlayerLayer.js";
import { IndoorPlayerLayer } from "./IndoorPlayerLayer.js";

function timeline(): ManorMovementTimeline {
  const value = new ManorMovementTimeline();
  value.start("session", { ...MANOR_SPAWN, targetX: null, targetY: null, moving: false, revision: 0 }, 0, 1_000, 0);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle.size = { width: 400, height: 300 };
  lifecycle.observerCallbacks.length = 0;
  lifecycle.frames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { lifecycle.frames.push(callback); return lifecycle.frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("devicePixelRatio", 1.5);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => lifecycle.size.width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => lifecycle.size.height });
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { lifecycle.observerCallbacks.push(() => callback([], this)); }
    observe(): void {} unobserve(): void {} disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ManorPlayerLayer lifecycle", () => {
  it("maps rectangular logical room axes independently", async () => {
    render(<IndoorPlayerLayer
      roomWidth={1_000}
      roomHeight={500}
      playerVisualHeightUnits={70}
      positionSource={{ render: () => ({ x: 501.25, y: 250.5 }) }}
      displayColor={null}
      className="test-player-layer"
      canvasClassName="test-player-canvas"
      ariaLabel="Test actor"
    />);
    await waitFor(() => expect(lifecycle.frames).toHaveLength(1));
    lifecycle.frames.shift()!(0);
    expect(lifecycle.positionSet).toHaveBeenLastCalledWith(200.5, 150.3);
  });

  it("owns one Pixi app and loop, interpolates without resize/recreation, and destroys everything", async () => {
    const movement = timeline();
    const view = render(<ManorPlayerLayer room={MANOR_MAIN_ROOM} timeline={movement} displayColor="#fb7185" />);
    await waitFor(() => expect(lifecycle.init).toHaveBeenCalledOnce());
    expect(lifecycle.init).toHaveBeenCalledWith(expect.objectContaining({
      antialias: true,
      resolution: 2,
      roundPixels: false
    }));
    expect(lifecycle.parseColor).toHaveBeenCalledWith("#fb7185");
    expect(lifecycle.constructor).toHaveBeenCalledOnce();
    expect(lifecycle.stop).toHaveBeenCalledOnce();
    expect(lifecycle.tickerStop).toHaveBeenCalledOnce();
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(lifecycle.resize).toHaveBeenCalledTimes(1);

    lifecycle.frames.shift()!(0);
    expect(lifecycle.positionSet).toHaveBeenLastCalledWith(
      MANOR_SPAWN.x / MANOR_FLOOR_SIZE * 400,
      MANOR_SPAWN.y / MANOR_FLOOR_SIZE * 300
    );
    expect(lifecycle.scaleSet).toHaveBeenLastCalledWith(
      expect.closeTo(
        Math.min(
          400 / MANOR_MAIN_ROOM.roomWidth,
          300 / MANOR_MAIN_ROOM.roomHeight
        ) * 70 / 42,
        10
      )
    );
    movement.applySnapshot("session", { x: MANOR_SPAWN.x + 23, y: 790, targetX: MANOR_SPAWN.x + 73, targetY: 790, moving: true, revision: 1 }, 1, 1_050, 50);
    lifecycle.frames.shift()!(66);
    expect(lifecycle.constructor).toHaveBeenCalledOnce();
    expect(lifecycle.resize).toHaveBeenCalledTimes(1);
    expect(lifecycle.positionSet.mock.calls.at(-1)?.[0]).toBeGreaterThan(
      MANOR_SPAWN.x / MANOR_FLOOR_SIZE * 400
    );

    lifecycle.size = { width: 300, height: 500 };
    lifecycle.observerCallbacks[0]!();
    expect(lifecycle.resize).toHaveBeenLastCalledWith(300, 500);
    lifecycle.observerCallbacks[0]!();
    expect(lifecycle.resize).toHaveBeenCalledTimes(2);
    lifecycle.frames.shift()!(82);
    expect(lifecycle.scaleSet).toHaveBeenLastCalledWith(
      expect.closeTo(
        Math.min(
          300 / MANOR_MAIN_ROOM.roomWidth,
          500 / MANOR_MAIN_ROOM.roomHeight
        ) * 70 / 42,
        10
      )
    );

    view.unmount();
    expect(lifecycle.destroy).toHaveBeenCalledWith(
      { removeView: true, releaseGlobalResources: false },
      { children: true }
    );
  });

  it("updates a remote actor when its appearance revision changes", async () => {
    const appearance = (revision: number): PlayerAppearanceSnapshot => ({
      schemaVersion: 1, catalogRevision: 1, revision, bodyVariantId: "default", poseId: "idle",
      slots: {}, styles: {}, activeHand: null
    });
    const occupant = (revision: number) => ({
      playerId: "guest-1", displayName: "Guest", displayColor: null, accessSource: "PARTY" as const,
      appearance: appearance(revision), spaceId: "manor_main_room" as const,
      position: { x: 200, y: 300, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0
    });
    const movement = timeline();
    const view = render(<ManorPlayerLayer room={MANOR_MAIN_ROOM} timeline={movement} displayColor={null} occupants={[occupant(1)]} />);
    await waitFor(() => expect(lifecycle.frames).toHaveLength(1));
    lifecycle.frames.shift()!(0);
    expect(lifecycle.updateAppearance).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
    view.rerender(<ManorPlayerLayer room={MANOR_MAIN_ROOM} timeline={movement} displayColor={null} occupants={[occupant(2)]} />);
    lifecycle.frames.shift()!(16);
    expect(lifecycle.updateAppearance).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });
});
