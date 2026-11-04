// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeathScreen } from "./DeathScreen.js";

afterEach(cleanup);

describe("DeathScreen", () => {
  it("is forced, focused, and prevents a double respawn request", () => {
    const onRespawn = vi.fn(() => "request-1");
    render(<DeathScreen open expectedXpLoss={12_345} respawnAvailableAt={null} connected error={null} onRespawn={onRespawn} />);
    expect(screen.getByRole("dialog", { name: "You fell" })).toBeTruthy();
    expect(screen.getByText("YOU FELL")).toBeTruthy();
    expect(screen.getByText("Lost 3% EXP (12,345 EXP)")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Respawn" });
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("button", { name: /cancel|close|back|return to game/i })).toBeNull();
    expect(screen.queryByText(/arrival protection|anchor/i)).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRespawn).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("lists what the death dropped next to the EXP loss", () => {
    render(<DeathScreen
      open
      expectedXpLoss={50}
      deathDrop={{
        outcome: "dropped",
        lines: [
          { kind: "backpack", itemId: "starter_backpack", name: "Backpack +0", quantity: 1 },
          { kind: "item", itemId: "iron_bar", name: "Iron Bar", quantity: 8 }
        ]
      }}
      respawnAvailableAt={null}
      connected
      error={null}
      onRespawn={() => null}
    />);
    expect(screen.getByText("Lost 3% EXP (50 EXP). Dropped Backpack +0, Iron Bar x8")).toBeTruthy();
  });

  it("shows disconnected and request error recovery states", () => {
    const { rerender } = render(<DeathScreen open expectedXpLoss={0} respawnAvailableAt={null} connected={false} error={null} onRespawn={() => null} />);
    expect(screen.getByText("No EXP was lost")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Reconnect");
    rerender(<DeathScreen open expectedXpLoss={null} respawnAvailableAt={null} connected error="Respawn was rejected." onRespawn={() => null} />);
    expect(screen.queryByText(/EXP/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("rejected");
    expect(screen.getByRole("button", { name: "Respawn" }).hasAttribute("disabled")).toBe(false);
  });

  it("counts down the authoritative respawn deadline before enabling the action", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const onRespawn = vi.fn(() => "request-timer");
      render(<DeathScreen
        open
        expectedXpLoss={906}
        respawnAvailableAt={110_000}
        connected
        error={null}
        onRespawn={onRespawn}
      />);
      const ten = screen.getByRole("button", { name: "Respawn (10)" }) as HTMLButtonElement;
      expect(ten.disabled).toBe(true);
      expect(ten.getAttribute("aria-describedby")).toBeNull();
      expect(screen.queryByText("Respawn is available in 10 seconds.")).toBeNull();
      fireEvent.click(ten);
      expect(onRespawn).not.toHaveBeenCalled();

      act(() => { vi.advanceTimersByTime(9_000); });
      expect(screen.getByRole("button", { name: "Respawn (1)" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1_000); });
      const ready = screen.getByRole("button", { name: "Respawn" }) as HTMLButtonElement;
      expect(ready.disabled).toBe(false);
      fireEvent.click(ready);
      expect(onRespawn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
