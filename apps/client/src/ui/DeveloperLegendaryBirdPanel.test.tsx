// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeveloperLegendaryBirdPanel } from "./DeveloperLegendaryBirdPanel.js";

describe("DeveloperLegendaryBirdPanel", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("selects a player, submits the chosen species once, and reports success", async () => {
    let resolveTrigger!: (value: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ players: [{ playerId: "player-1", playerName: "Robin", eligibleBastionFlagCount: 1 }] }), { status: 200 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveTrigger = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    render(<DeveloperLegendaryBirdPanel serverHttpBase="https://game.test" csrfToken="csrf" />);
    fireEvent.change(screen.getByLabelText("Player search"), { target: { value: "Rob" } });
    const player = await screen.findByRole("button", { name: /Robin/ });
    fireEvent.click(player);
    fireEvent.change(screen.getByLabelText("Species"), { target: { value: "lightning" } });
    const trigger = screen.getByRole("button", { name: "Trigger Event" });
    fireEvent.click(trigger);
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trigger);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveTrigger(new Response(JSON.stringify({ playerName: "Robin", birdSpecies: "lightning" }), { status: 200 }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Thunderbird triggered for Robin."));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ playerId: "player-1", birdSpecies: "lightning", operationKey: "11111111-1111-4111-8111-111111111111" });
  });
});
