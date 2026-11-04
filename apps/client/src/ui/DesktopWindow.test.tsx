// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindow, DesktopWindowTitle } from "./DesktopWindow.js";
import { defaultDesktopWindowBounds, desktopWindowSide, readSavedWindowBounds, resetDesktopWindowLayout, restoreWindowBounds, saveWindowBounds, setDesktopWindowPlayer } from "./desktopWindowLayout.js";

afterEach(cleanup);
function sample(key: string, compact = false, onClose = vi.fn()) {
  return <DesktopWindow windowKey={key} compact={compact} aria-label="Test window" onRequestClose={onClose}>
    <header className="game-app-header"><h2><DesktopWindowTitle>Test</DesktopWindowTitle></h2><button>Header action</button></header>
    <div className="game-app-body">Content</div>
  </DesktopWindow>;
}
describe("desktop window layout", () => {
  const area = { width: 1280, height: 700 };
  it("docks chat and Messages right and every other app left", () => {
    expect(desktopWindowSide("chat:public", false)).toBe("right");
    expect(desktopWindowSide("chat:direct", false)).toBe("right");
    expect(desktopWindowSide("app:inventory", false)).toBe("left");
    expect(desktopWindowSide("app:build", false)).toBe("left");
    const chat = defaultDesktopWindowBounds("chat:public", area, false, 0);
    const messages = defaultDesktopWindowBounds("chat:direct", area, false, 0);
    const inventory = defaultDesktopWindowBounds("app:inventory", area, false, 0);
    expect(chat.x + chat.width).toBe(area.width - 16);
    expect(messages.x + messages.width).toBe(area.width - 16);
    expect(inventory.x).toBe(16);
    expect(chat.y).toBe(messages.y);
    for (const rect of [chat, messages, inventory]) expect(rect.y + rect.height).toBeLessThanOrEqual(area.height - 16);
  });
  it("saves a moved rect per character and window, clamps it on restore, and resets", () => {
    localStorage.clear();
    setDesktopWindowPlayer("p1");
    const view = render(sample("test:saved"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Test window" }), { key: "ArrowRight", shiftKey: true });
    const saved = readSavedWindowBounds("test:saved");
    expect(saved).not.toBeNull();
    setDesktopWindowPlayer("p2");
    expect(readSavedWindowBounds("test:saved")).toBeNull();
    setDesktopWindowPlayer("p1");
    expect(restoreWindowBounds({ ...saved!, x: 5000, y: 5000 }, { width: 500, height: 400 }, { width: 420, height: 360 }).x).toBeLessThanOrEqual(72);
    view.unmount();
    saveWindowBounds("test:saved", { x: 10, y: 10, width: 500, height: 400 });
    expect(resetDesktopWindowLayout()).toBeGreaterThanOrEqual(1);
    expect(readSavedWindowBounds("test:saved")).toBeNull();
    setDesktopWindowPlayer(null);
  });
  it("snaps an open window back to its default when positions are reset", () => {
    localStorage.clear();
    setDesktopWindowPlayer("p1");
    render(sample("test:snap"));
    const initial = screen.getByRole("dialog").style.cssText;
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Test window" }), { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("dialog").style.cssText).not.toBe(initial);
    act(() => { resetDesktopWindowLayout(); });
    expect(screen.getByRole("dialog").style.cssText).toBe(initial);
    setDesktopWindowPlayer(null);
  });
});

describe("DesktopWindow", () => {
  it("shares the viewport stacking owner even when opened from an isolated dock", () => {
    render(<div style={{ isolation: "isolate" }}>{sample("test:portal")}</div>);
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
  });
  it("remembers independent moved and resized bounds across close/reopen", () => {
    const view = render(sample("test:persistence"));
    const initial = screen.getByRole("dialog").style.cssText;
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize window from bottom right" }), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Test window" }), { key: "ArrowRight" });
    const remembered = screen.getByRole("dialog").style.cssText;
    expect(remembered).not.toBe(initial);
    view.unmount();
    const other = render(sample("test:independent"));
    expect(screen.getByRole("dialog").style.cssText).toBe(initial);
    other.unmount();
    render(sample("test:persistence"));
    expect(screen.getByRole("dialog").style.cssText).toBe(remembered);
  });
  it("reclamps to a smaller viewport above the HUD", () => {
    render(sample("test:clamp"));
    const oldWidth = window.innerWidth, oldHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
    fireEvent(window, new Event("resize"));
    const frame = screen.getByRole("dialog");
    expect(parseFloat(frame.style.left) + parseFloat(frame.style.width)).toBeLessThanOrEqual(492);
    expect(parseFloat(frame.style.top) + parseFloat(frame.style.height)).toBeLessThanOrEqual(304);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: oldWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: oldHeight });
  });
  it("keeps action prompts compact and closes only the active window", () => {
    const close = vi.fn();
    const view = render(sample("test:compact", true, close));
    expect(parseFloat(screen.getByRole("dialog").style.width)).toBe(352);
    expect(screen.getByRole("dialog").style.height).toBe("auto");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
  });
  it("starts movement on unused title-bar space but preserves header actions", () => {
    render(sample("test:pointer"));
    const frame = screen.getByRole("dialog");
    frame.setPointerCapture = vi.fn();
    // jsdom needs a mouse event to supply the pointer event's button/coordinates.
    fireEvent(frame.querySelector("header")!, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
    expect(frame.setPointerCapture).toHaveBeenCalledOnce();
    fireEvent.pointerUp(frame);
    fireEvent(screen.getByRole("button", { name: "Header action" }), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(frame.setPointerCapture).toHaveBeenCalledOnce();
  });
  it.each(["top-left", "top-right", "bottom-left", "bottom-right"])("resizes from %s with pointer and keyboard while anchoring the opposite corner", (corner) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    render(sample(`test:corner:${corner}`));
    const frame = screen.getByRole("dialog");
    const read = () => ({ x: parseFloat(frame.style.left), y: parseFloat(frame.style.top), width: parseFloat(frame.style.width), height: parseFloat(frame.style.height) });
    const initial = read();
    const handle = screen.getByRole("button", { name: `Resize window from ${corner.replace("-", " ")}` });
    handle.setPointerCapture = vi.fn();
    const left = corner.endsWith("left"), top = corner.startsWith("top");
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 100 + (left ? 40 : -40), clientY: 100 + (top ? 30 : -30) }));
    fireEvent.pointerUp(handle);
    expect(read()).toEqual({ x: initial.x + (left ? 40 : 0), y: initial.y + (top ? 30 : 0), width: initial.width - 40, height: initial.height - 30 });
    expect(handle.setPointerCapture).toHaveBeenCalledOnce();
    fireEvent.keyDown(handle, { key: left ? "ArrowLeft" : "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle, { key: top ? "ArrowUp" : "ArrowDown" });
    expect(read()).toEqual({ x: initial.x, y: initial.y + (top ? 20 : 0), width: initial.width, height: initial.height - 20 });
  });
  it("does not expose resize controls while minimized", () => {
    render(<DesktopWindow windowKey="test:minimized" minimized aria-label="Minimized">Header</DesktopWindow>);
    expect(screen.queryAllByRole("button", { name: /Resize window/ })).toHaveLength(0);
  });
});
