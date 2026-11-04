// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistMenuTheme, readMenuTheme, useMenuTheme } from "./menuTheme.js";

afterEach(() => { cleanup(); localStorage.clear(); delete document.documentElement.dataset.menuTheme; vi.restoreAllMocks(); });
describe("menu appearance preference", () => {
  it("defaults to light, ignores invalid values and keeps players isolated", () => {
    expect(readMenuTheme("one")).toBe("light");
    localStorage.setItem("ashAtlas.player.one.menuTheme.v1", "invalid");
    expect(readMenuTheme("one")).toBe("light");
    persistMenuTheme("one", "dark");
    expect(readMenuTheme("one")).toBe("dark");
    expect(readMenuTheme("two")).toBe("light");
  });
  it("applies changes immediately and restores them after remount and player changes", () => {
    const first = renderHook(({ player }) => useMenuTheme(player), { initialProps: { player: "one" } });
    expect(document.documentElement.dataset.menuTheme).toBe("light");
    act(() => first.result.current[1]("dark"));
    expect(document.documentElement.dataset.menuTheme).toBe("dark");
    first.unmount();
    const next = renderHook(({ player }) => useMenuTheme(player), { initialProps: { player: "one" } });
    expect(next.result.current[0]).toBe("dark");
    next.rerender({ player: "two" });
    expect(document.documentElement.dataset.menuTheme).toBe("light");
    expect(readMenuTheme("one")).toBe("dark");
  });
  it("keeps a session usable when local storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(() => useMenuTheme("one"));
    act(() => result.current[1]("dark"));
    expect(document.documentElement.dataset.menuTheme).toBe("dark");
  });
});
