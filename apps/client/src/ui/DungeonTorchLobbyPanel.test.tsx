// @vitest-environment jsdom

import type { DungeonTorchLobbySnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DungeonTorchLobbyPanel } from "./DungeonTorchLobbyPanel.js";

const lobby = (overrides: Partial<DungeonTorchLobbySnapshot> = {}): DungeonTorchLobbySnapshot => ({
  lobbyId: "lobby-1", entranceId: "cave", dungeonId: "fangrock_cavern", dungeonName: "Fangrock Cavern",
  partyId: "party-1", leaderPlayerId: "leader", status: "open", revision: 1,
  torchCost: [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }],
  minTotalTorches: 1, maxTotalTorches: 10, totalTorches: 3,
  members: [
    { playerId: "leader", name: "Leader", torches: 2, ready: false },
    { playerId: "ally", name: "Ally", torches: 1, ready: true }
  ],
  message: null,
  ...overrides
});

afterEach(cleanup);

describe("DungeonTorchLobbyPanel", () => {
  it("shows every member's torches and ready state, with a stepper only on the viewer's row", () => {
    const onSetTorches = vi.fn();
    const { container } = render(<DungeonTorchLobbyPanel lobby={lobby()} selfPlayerId="ally" have={{ refined_oil: 40, wood: 2 }}
      onSetTorches={onSetTorches} />);
    expect(screen.getByLabelText("2 torches")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(container.textContent).toContain("Total 3 / 10 torches");
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("One torch more"));
    fireEvent.click(screen.getByLabelText("One torch fewer"));
    expect(onSetTorches.mock.calls).toEqual([[2], [0]]);
    expect(container.textContent).not.toMatch(/[×✕]/u);
  });

  it("stops adding at the cap and hides the stepper once the run starts", () => {
    const full = render(<DungeonTorchLobbyPanel lobby={lobby({ totalTorches: 10 })} selfPlayerId="leader" have={{}} onSetTorches={vi.fn()} />);
    expect((screen.getByLabelText("One torch more") as HTMLButtonElement).disabled).toBe(true);
    full.unmount();
    render(<DungeonTorchLobbyPanel lobby={lobby({ status: "started", message: null })} selfPlayerId="leader" have={{}} onSetTorches={vi.fn()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
