import { Texture, TextureSource } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { createLazySheets, RELEASE_AFTER_MS, type SheetView } from "./jacketSheets.js";

const view: SheetView = { flip: false, frameWidth: 4, frameHeight: 4, rootX: 2, rootY: 2, pages: ["a-0.png"], frames: [[0, 0, 0], [0, 4, 0]] };
const urls = { "dir/a-0.png": async () => "url-a" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const page = () => new Texture({ source: new TextureSource({ width: 8, height: 4 }) });

describe("lazy jacket sheets", () => {
  it("releases a clip-side unused for RELEASE_AFTER_MS and reloads it on next use", async () => {
    const load = vi.fn(async () => page());
    const unload = vi.fn(async () => undefined);
    const sheets = createLazySheets<"a">("test", "dir/", urls, () => view, load, unload);
    expect(sheets.get("a", "L")).toBeNull();
    await flush();
    expect(sheets.get("a", "L")).toHaveLength(2);
    expect(sheets.sweep(performance.now() + RELEASE_AFTER_MS / 2)).toBe(0);
    expect(sheets.sweep(performance.now() + RELEASE_AFTER_MS + 1)).toBe(1);
    expect(unload).toHaveBeenCalledWith("url-a");
    expect(sheets.state("a", "L")).toBe("none");
    expect(sheets.get("a", "L")).toBeNull();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not request a failed sheet again every frame (backoff)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const load = vi.fn(async (): Promise<Texture> => { throw new Error("404"); });
    const sheets = createLazySheets<"a">("test", "dir/", urls, () => view, load, async () => undefined);
    sheets.get("a", "L");
    await flush();
    expect(sheets.state("a", "L")).toBe("failed");
    for (let i = 0; i < 30; i += 1) expect(sheets.get("a", "L")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
