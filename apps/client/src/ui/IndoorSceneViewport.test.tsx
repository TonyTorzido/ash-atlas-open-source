// @vitest-environment jsdom

import { MANOR_SPAWN } from "@ash-atlas/shared";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManorMovementTimeline } from "../movement/manorMovementTimeline.js";

vi.mock("./ManorPlayerLayer.js", () => ({
  ManorPlayerLayer: () => <div data-testid="manor-player" />
}));

import { ManorFoyerScene } from "./ManorFoyerScene.js";
import { ManorScene } from "./ManorScene.js";

function timeline(): ManorMovementTimeline {
  const value = new ManorMovementTimeline();
  value.start("session", {
    ...MANOR_SPAWN,
    targetX: null,
    targetY: null,
    moving: false,
    revision: 0
  }, 0, 1_000, 0);
  return value;
}

afterEach(cleanup);

describe("indoor scene roots", () => {
  it("keeps the root full-screen while reserving all phone HUD boundaries as content padding", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const indoorStyles = readFileSync(resolve(process.cwd(), "src/ui/IndoorScene.css"), "utf8");
    const root = indoorStyles.match(/\.indoor-scene-viewport \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const phone = styles.match(/html\[data-ui-profile="phone"\] \.indoor-scene-viewport \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const manor = styles.match(/\.manor-scene \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const frame = indoorStyles.match(/\.indoor-scene-stage-frame \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const stage = indoorStyles.match(/\.indoor-scene-stage \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(root).toContain("position: fixed");
    expect(root).toContain("inset: 0");
    expect(root).toContain("box-sizing: border-box");
    expect(root).toContain("container-type: size");
    expect(root).toContain("padding: var(--indoor-content-top) var(--indoor-content-right) var(--indoor-content-bottom) var(--indoor-content-left)");
    expect(phone).toContain("--indoor-content-top: calc(var(--hud-safe-top) + var(--hud-chat-height) + 8px)");
    expect(phone).toContain("--indoor-content-right: var(--hud-safe-right)");
    expect(phone).toContain("--indoor-content-bottom: var(--hud-bottom-bar-height)");
    expect(phone).toContain("--indoor-content-left: var(--hud-safe-left)");
    expect(phone).not.toContain("\n  top:");
    expect(phone).not.toContain("\n  bottom:");
    expect(manor).toContain("calc(var(--indoor-content-top) + var(--indoor-manor-gap, 12px))");
    expect(frame).toContain("width: 100%");
    expect(frame).toContain("height: 100%");
    expect(frame).toContain("min-width: 0");
    expect(frame).toContain("min-height: 0");
    expect(frame).toContain("overflow: clip");
    expect(frame).toContain("container-type: size");
    expect(stage).toContain("position: relative");
    expect(stage).toContain("max-width: 100%");
    expect(stage).toContain("max-height: 100%");
    expect(stage).not.toContain("will-change: translate");
  });

  it("mounts the Manor room in the canonical indoor viewport", () => {
    const view = render(<ManorScene
      timeline={timeline()}
      displayColor={null}
      disabled={false}
      movementDisabled={false}
      occupants={[]}
      ownPlayerId="player-1"
      canKick={false}
      interactionIntent={null}
      onMove={vi.fn()}
      onInteract={vi.fn()}
      onCancelInteraction={vi.fn()}
      onKick={() => false}
    />);
    const viewport = view.container.querySelector(".manor-scene.indoor-scene-viewport")!;
    const frame = viewport.querySelector(".indoor-scene-stage-frame.manor-stage-wrap")!;
    const stage = frame.querySelector('.indoor-scene-stage.manor-floor[data-indoor-view="fit"]');
    expect(stage).toBeTruthy();
  });

  it("mounts the compatibility foyer in the same viewport", () => {
    const view = render(<ManorFoyerScene
      manorId="manor-1"
      timeline={timeline()}
      displayColor={null}
      occupants={[]}
      disabled={false}
      movementDisabled={false}
      onMove={vi.fn()}
      onUsePortal={vi.fn()}
    />);
    const viewport = view.container.querySelector(".manor-foyer-scene.indoor-scene-viewport")!;
    expect(viewport.querySelector('.indoor-scene-stage.manor-foyer-room[data-indoor-view="fit"]')).toBeTruthy();
  });
});
