// @vitest-environment jsdom

import { emptyInventoryTotals, type TanneryStateSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TanneryPrompt } from "./TanneryPrompt.js";

afterEach(cleanup);

describe("TanneryPrompt", () => {
  it("sets the batch to the maximum supported by current ingredients", () => {
    const onStart = vi.fn();
    render(<TanneryPrompt
      state={state()}
      inventory={{
        playerId: "owner",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), deer_hide: 7 }
      }}
      feedback={null}
      busy={false}
      onStart={onStart}
      onCollect={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Max" }));

    expect(screen.getByText("1750 Leathers")).toBeTruthy();
    expect(screen.getByRole("img", { name: /7, have 7$/u }).textContent).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "Queue 1750 Leathers" }));
    expect(onStart).toHaveBeenCalledWith("deer_hide", 7);
  });

  it("lists held graded items to break down and asks before using an Epic find", () => {
    const onStart = vi.fn(() => true);
    render(<TanneryPrompt
      state={state()}
      inventory={{
        playerId: "owner",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), chimera_horn: 1, fang: 4 } as never
      }}
      feedback={null}
      busy={false}
      onStart={onStart}
      onCollect={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Breakdown" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Chimera Horn/u }));
    fireEvent.click(screen.getByRole("button", { name: "Queue 8 Bones" }));
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText("Use a rare find?")).toBeTruthy();
    expect(screen.getByText("This will use your Chimera Horn (Epic).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(onStart).toHaveBeenCalledWith("chimera_horn", 1, { confirmHighGrade: true });
  });
});

function state(): TanneryStateSnapshot {
  return {
    tannery: {
      tanneryId: "00000000-0000-4000-8000-000000000002",
      manorId: "00000000-0000-4000-8000-000000000003",
      ownerPlayerId: "owner",
      ownerUsername: "Ash",
      regionCode: "world-test",
      lat: 35,
      lon: -106,
      builtAt: "2026-01-01T00:00:00.000Z",
      placementRevision: 1
    },
    jobs: [],
    queueCapacity: 5,
    occupiedSlots: 0,
    serverTime: Date.now()
  };
}
