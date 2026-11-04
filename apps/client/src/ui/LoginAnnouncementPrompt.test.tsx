// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginAnnouncementPrompt } from "./LoginAnnouncementPrompt.js";

afterEach(cleanup);

describe("LoginAnnouncementPrompt", () => {
  it("uses one focused forced Close action and preserves announcement paragraphs", () => {
    const onClose = vi.fn();
    render(<LoginAnnouncementPrompt
      announcement={{
        id: "22222222-2222-4222-8222-222222222222",
        title: "Realm Update",
        message: "First paragraph.\n\nSecond paragraph.",
        publishedAt: "2026-08-31T12:00:00.000Z"
      }}
      onClose={onClose}
    />);
    const dialog = screen.getByRole("dialog", { name: "Announcement: Realm Update" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("ANNOUNCEMENT")).toBeTruthy();
    expect(screen.getByText("First paragraph. Second paragraph.").className).toContain("announcement-message");
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("Close");
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.click(buttons[0]!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
