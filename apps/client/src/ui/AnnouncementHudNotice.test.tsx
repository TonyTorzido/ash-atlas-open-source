// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncementHudNotice } from "./AnnouncementHudNotice.js";

afterEach(cleanup);

describe("AnnouncementHudNotice", () => {
  it("is a non-modal region with one explicit Close action", () => {
    const onClose = vi.fn();
    render(<AnnouncementHudNotice
      announcement={{
        id: "22222222-2222-4222-8222-222222222222",
        title: "Live notice",
        message: "First paragraph\n\nSecond paragraph",
        publishedAt: "2026-09-01T12:00:00.000Z"
      }}
      error={null}
      onClose={onClose}
    />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Player announcement" })).toBeTruthy();
    expect(screen.getByText("First paragraph Second paragraph")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
