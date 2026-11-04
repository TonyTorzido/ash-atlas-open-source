// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LootGoldHold, type LootLaunch } from "../combat/lootFly.js";
import { LOOT_HANG_MS, LOOT_MAGNET_MS, LOOT_POP_MS, LootFlyRunner } from "./lootFlyRunner.js";

const gold: LootLaunch = {
  kind: "gold", itemId: null, name: "Gold", quantity: 22, rarity: "common", holdIds: ["gold:a"], folded: 0, origin: { x: 100, y: 200 }
};
const wood: LootLaunch = { ...gold, kind: "item", itemId: "wood", name: "Wood", quantity: 3, holdIds: [] };

type Listener = () => void;
function fakeAnimation(): { animation: Animation; finish(): void } {
  const listeners = new Map<string, Listener>();
  const animation = {
    addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
    cancel: vi.fn()
  } as unknown as Animation;
  return { animation, finish: () => listeners.get("finish")?.() };
}

let nowMs = 0;
let frame: (() => void) | null = null;
let player = { x: 50, y: 400 };
const goldTarget = document.createElement("div");
const itemTarget = document.createElement("div");

function build(reduced: boolean, hold = new LootGoldHold()) {
  const layer = document.createElement("div");
  document.body.append(layer);
  const pops: Array<ReturnType<typeof fakeAnimation>> = [];
  layer.animate = vi.fn(() => { const fake = fakeAnimation(); pops.push(fake); return fake.animation; }) as never;
  const icons: HTMLElement[] = [];
  // Child icons get their own fake animate (pop) through the prototype.
  HTMLElement.prototype.animate = function (this: HTMLElement) {
    const fake = fakeAnimation();
    if (this.classList.contains("loot-fly-icon")) { pops.push(fake); icons.push(this); }
    return fake.animation;
  } as never;
  const onArrive = vi.fn();
  const runner = new LootFlyRunner({
    layer, goldHold: hold, onArrive,
    createIcon: () => document.createElement("img"),
    findTargets: () => ({ gold: goldTarget, item: itemTarget }),
    origin: () => ({ x: 0, y: 0 }), playerPoint: () => player, iconPx: () => 36,
    reducedMotion: () => reduced, now: () => nowMs, random: () => 0.5
  });
  return { runner, layer, pops, onArrive, hold };
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 0;
  player = { x: 50, y: 400 };
  frame = null;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { frame = null; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("LootFlyRunner", () => {
  it("under reduced motion skips the arcs: only the +N at the player, the HUD pulse and the hold release", () => {
    const hold = new LootGoldHold();
    hold.add("gold:a", 22, 0);
    const { runner, layer, onArrive } = build(true, hold);
    runner.launch([gold]);
    expect(layer.querySelector(".loot-fly-icon")).toBeNull();
    const count = layer.querySelector(".loot-fly-count");
    expect(count?.textContent).toBe("+22");
    expect(count?.classList.contains("is-gold")).toBe(true);
    expect(hold.held(1)).toBe(0);
    expect(onArrive).toHaveBeenCalledOnce();
  });

  it("bursts, hangs, then magnets into the player's live position and shows +N there", () => {
    const hold = new LootGoldHold();
    hold.add("gold:a", 22, 0);
    const { runner, layer, pops } = build(false, hold);
    runner.launch([gold, wood]);
    expect(runner.activeCount()).toBe(2);
    expect(layer.querySelectorAll(".loot-fly-icon")).toHaveLength(2);
    expect(layer.querySelector(".loot-fly-count")).toBeNull();

    pops.forEach((pop) => pop.finish());
    vi.advanceTimersByTime(LOOT_HANG_MS + 1);
    const icon = layer.querySelector<HTMLElement>(".loot-fly-icon")!;
    nowMs = 120;
    player = { x: 300, y: 500 };
    frame?.();
    // Mid-pull the icon already heads for where the player is now, not where they were.
    expect(icon.style.transform).toContain("scale(");
    nowMs = LOOT_MAGNET_MS + 10;
    player = { x: 320, y: 520 };
    frame?.();
    expect(layer.querySelectorAll(".loot-fly-icon")).toHaveLength(0);
    expect(runner.activeCount()).toBe(0);
    const counts = Array.from(layer.querySelectorAll(".loot-fly-count")).map((node) => node.textContent);
    expect(counts.sort()).toEqual(["+22", "+3"]);
    expect(hold.held(1)).toBe(0);
    expect(LOOT_POP_MS).toBeGreaterThanOrEqual(300);
    expect(LOOT_POP_MS).toBeLessThanOrEqual(320);
  });
});
