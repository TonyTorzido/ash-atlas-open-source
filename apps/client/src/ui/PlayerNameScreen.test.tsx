// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlayerNameScreen } from "./PlayerNameScreen.js";

describe("PlayerNameScreen", () => {
  it("requires a strict name and one of exactly five accessible personal colors", () => {
    const submit = vi.fn(async () => undefined);
    render(
      <PlayerNameScreen
        busy={false}
        message={null}
        onSubmit={submit}
        onLogout={vi.fn(async () => undefined)}
      />
    );

    const button = screen.getByRole("button", { name: "Create Player" });
    const nameInput = screen.getByLabelText("Display name");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.queryByRole("radio", { name: /black/i })).toBeNull();

    fireEvent.change(nameInput, {
      target: { value: " Avery " }
    });
    expect(screen.getByText("Use 3-20 English letters only.")).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.change(nameInput, {
      target: { value: "Avery" }
    });
    fireEvent.click(screen.getByRole("radio", { name: "Purple" }));
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);

    expect(submit).toHaveBeenCalledWith("Avery", "purple");
  });

  it("shows a clean inline taken-name response without changing the selection", () => {
    render(
      <PlayerNameScreen
        busy={false}
        message="That name is already taken."
        onSubmit={vi.fn(async () => undefined)}
        onLogout={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByRole("alert").textContent).toBe("That name is already taken.");
  });
});
