// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemedSelect } from "./ThemedSelect.js";

afterEach(cleanup);

describe("ThemedSelect", () => {
  it("uses an accessible custom listbox without native select presentation", () => {
    const onChange = vi.fn();
    const view = render(<ThemedSelect
      label="Access mode"
      value="private"
      options={[
        { value: "private", label: "Private" },
        { value: "public", label: "Public" }
      ]}
      onChange={onChange}
    />);
    expect(view.container.querySelector("select")).toBeNull();
    const trigger = screen.getByRole("combobox", { name: "Access mode" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Access mode" });
    expect(withinOptions(listbox)).toEqual(["Private", "Public"]);
    fireEvent.click(screen.getByRole("option", { name: "Public" }));
    expect(onChange).toHaveBeenCalledWith("public");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("supports keyboard opening, navigation, selection, and escape", () => {
    const onChange = vi.fn();
    render(<ThemedSelect
      label="Duration"
      value="1h"
      options={[
        { value: "1h", label: "1 hour" },
        { value: "24h", label: "24 hours" }
      ]}
      onChange={onChange}
    />);
    const trigger = screen.getByRole("combobox", { name: "Duration" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("24h");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

function withinOptions(listbox: HTMLElement): string[] {
  return Array.from(listbox.querySelectorAll('[role="option"]'), (option) => (option.textContent ?? "").replace("✓", ""));
}
