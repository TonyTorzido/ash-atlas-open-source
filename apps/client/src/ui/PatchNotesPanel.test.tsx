// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PatchNotesPanel } from "./PatchNotesPanel.js";

afterEach(cleanup);

describe("PatchNotesPanel", () => {
  it("renders newest releases first with public versions, generations, and notes", () => {
    render(<PatchNotesPanel
      open
      releases={[
        {
          gameSha: "a".repeat(40),
          gameGeneration: "test/t914",
          createdAt: "2026-09-07T21:16:46.000Z",
          publicVersion: "0.1.4",
          patchNotes: ["Newest change."]
        },
        {
          gameSha: "b".repeat(40),
          gameGeneration: "test/t913",
          createdAt: "2026-01-08T17:00:00.000Z",
          publicVersion: "0.1.3",
          patchNotes: ["Earlier change."]
        }
      ]}
      onClose={() => undefined}
    />);

    expect(screen.getByRole("dialog", { name: "Patch Notes" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 3 }).map(({ textContent }) => textContent)).toEqual([
      "Version 0.1.4", "Version 0.1.3"
    ]);
    expect(screen.getByText(/test\/t914/)).toBeTruthy();
    expect(screen.getByText("Created Sep 7, 2026, 3:16 PM MDT")).toBeTruthy();
    expect(screen.getByText("Created Jan 8, 2026, 10:00 AM MST")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map(({ textContent }) => textContent)).toEqual([
      "Newest change.", "Earlier change."
    ]);
  });

  it("shows the canonical unavailable card for empty history", () => {
    render(<PatchNotesPanel open releases={[]} onClose={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Patch Notes Unavailable" })).toBeTruthy();
    expect(screen.getByText("Recent update notes are not available for this game version.")).toBeTruthy();
  });
});
