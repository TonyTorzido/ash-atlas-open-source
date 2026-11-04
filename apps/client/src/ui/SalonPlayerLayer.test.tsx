// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.doMock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    screen = { width: 1, height: 1 };
    renderer = {
      resize: (width: number, height: number) => {
        this.screen.width = width;
        this.screen.height = height;
      }
    };
    stage = { addChild: () => undefined };
    ticker = { stop: () => undefined };
    async init(): Promise<void> {}
    stop(): void {}
    render(): void {}
    destroy(): void {}
  }
}));

vi.doMock("@ash-atlas/player-renderer", () => ({
  PixiTextureCache: class {},
  PlayerRenderer: class {
    root = {
      scale: { set: () => undefined },
      position: { set: () => undefined, y: 0 },
      getLocalBounds: () => ({ x: -25, y: -100, width: 50, height: 100 })
    };
    async updateAppearance(): Promise<void> {}
  },
  playerDisplayColorNumber: () => 0
}));

vi.doMock("@ash-atlas/player-renderer/asset-registry", () => ({
  playerAppearanceAssetUrl: () => null
}));

vi.doMock("./IndoorPlayerLayer.js", () => ({
  IndoorPlayerLayer: () => null
}));

const {
  clampPlayerAppearancePreviewPan,
  PlayerAppearancePreview,
  playerAppearancePreviewFitScale,
  playerAppearancePreviewY
} = await import("./SalonPlayerLayer.js");

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("player appearance preview placement", () => {
  it("centers the scaled visual bounds in the viewport", () => {
    expect(playerAppearancePreviewY(
      300,
      2,
      { y: -60, height: 80 },
      "centered"
    )).toBe(190);
  });

  it("preserves the grounded Salon placement by default", () => {
    expect(playerAppearancePreviewY(
      300,
      2,
      { y: -60, height: 80 },
      "grounded"
    )).toBe(210);
  });

  it("fits the complete visual inside both padded viewport axes", () => {
    expect(playerAppearancePreviewFitScale(
      200,
      300,
      { width: 100, height: 200 },
      20
    )).toBe(1.3);
  });

  it("resets pan at regular zoom and bounds it against zoomed overflow", () => {
    expect(clampPlayerAppearancePreviewPan(
      200,
      300,
      160,
      260,
      1,
      { x: 100, y: -100 },
      20
    )).toEqual({ x: 0, y: 0 });
    expect(clampPlayerAppearancePreviewPan(
      200,
      300,
      160,
      260,
      2,
      { x: 500, y: -500 },
      20
    )).toEqual({ x: 80, y: -130 });
  });

  it("shows the live zoom percentage, caps at 500%, and resets to regular fit", () => {
    render(<PlayerAppearancePreview displayColor={null} interactive />);
    const preview = screen.getByLabelText("Character appearance");
    const controls = screen.getByRole("group", { name: "Preview zoom controls" });

    expect(screen.getByRole("button", {
      name: "Reset preview, current zoom 100%"
    }).textContent).toBe("100%");
    expect(controls.querySelectorAll("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();

    fireEvent.wheel(preview, { deltaY: -100 });
    expect(screen.getByRole("button", {
      name: "Reset preview, current zoom 116%"
    }).textContent).toBe("116%");

    fireEvent.wheel(preview, { deltaY: -10_000 });

    const reset = screen.getByRole("button", {
      name: "Reset preview, current zoom 500%"
    });
    expect(reset.textContent).toBe("500%");

    fireEvent.click(reset);
    expect(screen.getByRole("button", {
      name: "Reset preview, current zoom 100%"
    }).textContent).toBe("100%");
  });
});
