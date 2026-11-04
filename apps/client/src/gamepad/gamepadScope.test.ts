// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { findKeyboardMovementBlock } from "./gamepadScope.js";
import { perfMetrics } from "../perf/perfMetrics.js";

// jsdom has no layout, so every element the helper must see as "visible" gets a fake box.
function add(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  const element = host.firstElementChild as HTMLElement;
  element.getBoundingClientRect = () => ({ width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(element);
  return element;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("findKeyboardMovementBlock", () => {
  it("lets WASD through with a non-modal desktop window (chat, messages) open, even when it holds focus", () => {
    const chat = add(`<aside role="dialog" aria-modal="false" tabindex="-1" data-desktop-window="chat:public"><button id="b">Send</button></aside>`);
    chat.focus();
    expect(findKeyboardMovementBlock("KeyW", document.activeElement)).toBeNull();
    expect(findKeyboardMovementBlock("KeyD", document.activeElement)).toBeNull();
    expect(findKeyboardMovementBlock("Space", document.activeElement)).toBeNull();
  });

  it("lets WASD through for a non-modal world prompt or target picker", () => {
    add(`<div class="game-action-prompt">Chop</div>`);
    add(`<div class="game-target-picker" role="dialog" aria-modal="false">Pick</div>`);
    expect(findKeyboardMovementBlock("KeyS", document.body)).toBeNull();
  });

  it("blocks for a visible aria-modal element and for the open game menu", () => {
    const modal = add(`<div role="dialog" aria-modal="true" id="shop">Shop</div>`);
    expect(findKeyboardMovementBlock("KeyW", document.body)?.reason).toContain("modal");
    modal.remove();
    add(`<div class="phone-hud phone-hud-menu-open"></div>`);
    expect(findKeyboardMovementBlock("KeyW", document.body)?.reason).toContain("menu-open");
  });

  it("ignores a hidden modal", () => {
    const modal = add(`<div aria-modal="true" style="display:none"></div>`);
    modal.style.display = "none";
    expect(findKeyboardMovementBlock("KeyW", document.body)).toBeNull();
  });

  it("yields arrow keys, but not WASD, to a control focused inside a non-modal window", () => {
    add(`<aside role="dialog" aria-modal="false"><button id="tab">Tab</button></aside>`);
    const control = document.getElementById("tab") as HTMLElement;
    control.focus();
    expect(findKeyboardMovementBlock("ArrowDown", control)?.reason).toContain("arrow-focus-in-window");
    expect(findKeyboardMovementBlock("KeyW", control)).toBeNull();
  });
});

describe("perfMetrics key-ignored diagnostic", () => {
  it("counts reasons and clears the window when taken", () => {
    perfMetrics.takeKeyIgnored();
    perfMetrics.noteKeyIgnored("modal aside.x");
    perfMetrics.noteKeyIgnored("modal aside.x");
    perfMetrics.noteKeyIgnored("no-world-state");
    expect(perfMetrics.takeKeyIgnored()).toBe("modal aside.x:2,no-world-state:1");
    expect(perfMetrics.takeKeyIgnored()).toBe("");
  });
});
