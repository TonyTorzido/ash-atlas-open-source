// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "./TopBar.js";

afterEach(cleanup);

describe("TopBar Messages launcher", () => {
  it("caps visual unread text, preserves the exact accessible count, and omits zero", () => {
    const props = {
      connectionStatus: "online",
      username: "Ranger",
      playerId: "player-1",
      flagColor: "#aa3300",
      colorBusy: false,
      onFlagColorChange: vi.fn(),
      onOpenProfile: vi.fn(),
      onOpenMessages: vi.fn(),
      onLogout: vi.fn()
    };
    const view = render(<TopBar {...props} unreadDirectMessageCount={137} />);
    fireEvent.click(screen.getByRole("button", { name: /Ranger/ }));
    expect(screen.getByRole("menuitem", { name: "Messages, 137 unread" }).textContent).toBe("Messages (99+)");

    view.rerender(<TopBar {...props} unreadDirectMessageCount={0} />);
    expect(screen.getByRole("menuitem", { name: "Messages" }).textContent).toBe("Messages");
  });
});
