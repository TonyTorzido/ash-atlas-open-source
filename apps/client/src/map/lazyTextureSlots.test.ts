import { describe, expect, it, vi } from "vitest";
import type { Texture } from "pixi.js";
import { LazyTextureSlots, retainReady } from "./lazyTextureSlots.js";

const texture = (label: string) => ({ label }) as unknown as Texture;

describe("LazyTextureSlots", () => {
  it("starts a load once, reports undefined until ready, then notifies", async () => {
    const arrived = vi.fn();
    const slots = new LazyTextureSlots(arrived);
    const loader = vi.fn(async () => texture("a"));
    slots.define("a", loader);
    expect(slots.peek("a")).toBeUndefined();
    expect(slots.request("a")).toBeUndefined();
    expect(slots.request("a")).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
    await slots.load("a");
    expect(arrived).toHaveBeenCalledTimes(1);
    expect(arrived).toHaveBeenCalledWith("a");
    expect(slots.request("a")).toBe(slots.peek("a"));
    expect(slots.loadedCount()).toBe(1);
  });

  it("ignores unknown names and keeps the first definition", () => {
    const slots = new LazyTextureSlots(() => undefined);
    expect(slots.request("missing")).toBeUndefined();
    const first = vi.fn(async () => texture("1"));
    slots.define("x", first);
    slots.define("x", async () => texture("2"));
    void slots.request("x");
    expect(first).toHaveBeenCalledTimes(1);
  });
});

describe("retainReady", () => {
  it("returns the same array when everything is ready", () => {
    const items = [1, 2, 3];
    expect(retainReady(items, () => true)).toBe(items);
  });

  it("drops held-back items, preserving order, and checks every item", () => {
    const seen: number[] = [];
    const kept = retainReady([1, 2, 3, 4], (item) => {
      seen.push(item);
      return item % 2 === 0;
    });
    expect(kept).toEqual([2, 4]);
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});
