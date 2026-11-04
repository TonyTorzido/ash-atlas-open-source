// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSoftKeyboardTracking, isTextEntry } from "./softKeyboard.js";

describe("isTextEntry", () => {
  it("counts typed fields but not read-only number boxes or buttons", () => {
    document.body.innerHTML = '<input id="a"><input id="b" readonly><input id="c" type="checkbox"><textarea id="d"></textarea><textarea id="e" readonly></textarea>';
    const el = (id: string) => document.getElementById(id);
    expect(isTextEntry(el("a"))).toBe(true);
    expect(isTextEntry(el("b"))).toBe(false);
    expect(isTextEntry(el("c"))).toBe(false);
    expect(isTextEntry(el("d"))).toBe(true);
    expect(isTextEntry(el("e"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("installSoftKeyboardTracking", () => {
  afterEach(() => document.documentElement.removeAttribute("data-text-entry"));

  it("marks data-text-entry for typed fields only", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<input id="a"><input id="b" readonly>';
    installSoftKeyboardTracking(document);
    const root = document.documentElement;
    document.getElementById("a")!.focus();
    expect(root.hasAttribute("data-text-entry")).toBe(true);
    document.getElementById("b")!.focus();
    vi.runAllTimers();
    expect(root.hasAttribute("data-text-entry")).toBe(false);
    vi.useRealTimers();
  });
});
