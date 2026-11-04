import type maplibregl from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

import { attachMapRuntime, type MapRuntimeHandlers } from "./mapRuntime.js";

describe("map runtime", () => {
  it("owns MapLibre and movement-input listener registration and teardown", () => {
    const canvas = new EventTarget();
    const on = vi.fn();
    const map = {
      on,
      once: vi.fn(),
      off: vi.fn(),
      getCanvas: vi.fn(() => canvas),
      dragPan: { enable: vi.fn(), disable: vi.fn(), isEnabled: vi.fn(() => true) },
      dragRotate: { disable: vi.fn() },
      touchZoomRotate: {
        disableRotation: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        isEnabled: vi.fn(() => true)
      },
      isSourceLoaded: vi.fn(() => true)
    } as unknown as maplibregl.Map;
    const noop = vi.fn();
    const onBaseMapPainted = vi.fn();
    const handlers: MapRuntimeHandlers = {
      onLoad: noop,
      onBaseMapPainted,
      onWorldRelease: noop,
      onZoom: noop,
      onZoomStart: noop,
      onZoomEnd: noop,
      onRender: noop,
      onIdle: noop,
      onDragStart: noop,
      onDragEnd: noop,
      onMoveStart: noop,
      onMoveEnd: noop,
      onResize: noop,
      onContextMenu: noop,
      onPendingClick: noop,
      onPendingClickEnd: noop,
      onClick: noop,
      getGameplayArea: () => null,
      onMove: noop,
      onLongPressStart: noop,
      onLongPressMove: noop,
      onLongPressRelease: noop,
      onLongPressCancel: noop
    };

    const attachment = attachMapRuntime(map, handlers);
    expect(map.on).toHaveBeenCalledWith("click", expect.any(Function));
    expect(map.on).toHaveBeenCalledWith("render", expect.any(Function));
    expect(map.dragPan.enable).toHaveBeenCalledOnce();
    expect(map.dragRotate.disable).toHaveBeenCalledOnce();
    const render = on.mock.calls.find(([event]) => event === "render")?.[1] as
      (() => void) | undefined;
    render?.();
    expect(onBaseMapPainted).toHaveBeenCalledOnce();
    attachment.invalidateBaseMapPaint();
    render?.();
    expect(onBaseMapPainted).toHaveBeenCalledTimes(2);

    attachment.detach();
    expect(map.off).toHaveBeenCalledWith("click", expect.any(Function));
    expect(map.off).toHaveBeenCalledWith("render", expect.any(Function));
  });
});
