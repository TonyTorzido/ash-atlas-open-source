// @vitest-environment jsdom

import { type LoomStateSnapshot, type LoomWorldSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoomActionPrompt } from "./LoomPrompt.js";

afterEach(cleanup);

describe("LoomActionPrompt shared exterior access", () => {
  it("enables one Use action for a nearby non-owner without owner copy", () => {
    const onWeave = vi.fn();
    render(<LoomActionPrompt
      loom={loom()}
      state={state()}
      connected
      feedback={null}
      collecting={false}
      onWeave={onWeave}
      onCollect={vi.fn()}
      onClose={vi.fn()}
    />);

    const use = screen.getByRole("button", { name: "Use" });
    expect((use as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Owned by Ash.")).toBeNull();
    fireEvent.click(use);
    expect(onWeave).toHaveBeenCalledOnce();
    expect(onWeave).toHaveBeenCalledWith();
  });
});

function loom(): LoomWorldSnapshot {
  return {
    loomId: "00000000-0000-4000-8000-000000000002",
    manorId: "00000000-0000-4000-8000-000000000003",
    ownerPlayerId: "owner",
    ownerUsername: "Ash",
    regionCode: "world-test",
    lat: 35,
    lon: -106,
    builtAt: "2026-01-01T00:00:00.000Z",
    placementRevision: 1
  };
}

function state(): LoomStateSnapshot {
  return {
    loom: loom(),
    jobs: [],
    queueCapacity: 5,
    occupiedSlots: 0,
    serverTime: Date.now()
  };
}
