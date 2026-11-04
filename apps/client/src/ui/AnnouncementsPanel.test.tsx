// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncementsPanel } from "./AnnouncementsPanel.js";

afterEach(cleanup);

describe("AnnouncementsPanel", () => {
  it("renders newest-first history with safe multiline content", () => {
    render(<AnnouncementsPanel open announcements={[
      { id: "22222222-2222-4222-8222-222222222222", title: "Newest", message: "One\n\nTwo", publishedAt: "2026-08-31T12:00:00.000Z" },
      { id: "33333333-3333-4333-8333-333333333333", title: "Earlier", message: "Old", publishedAt: "2026-08-30T12:00:00.000Z" }
    ]} onClose={() => undefined} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map(({ textContent }) => textContent)).toEqual(["Newest", "Earlier"]);
    expect(screen.getByText("One Two").className).toContain("announcement-message");
  });

  it("contains failure and retry inside the app", () => {
    const retry = vi.fn();
    render(<AnnouncementsPanel open announcements={[]} error="Temporarily unavailable" onRetry={retry} onClose={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("Temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
