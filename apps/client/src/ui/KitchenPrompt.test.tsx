// @vitest-environment jsdom

import {
  clientMessageSchema,
  emptyInventoryTotals,
  type ClientMessage,
  type KitchenRecipeId,
  type KitchenStateSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientCommandPort } from "../client/clientCommandPort.js";
import { ManorClient } from "../client/domains/manorClient.js";
import { KitchenPrompt } from "./KitchenPrompt.js";

const KITCHEN_ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("KitchenPrompt quantity contract", () => {
  it("shows one-based batches but submits the raw input for each selected batch", () => {
    const onStart = vi.fn(() => true);
    renderPrompt(onStart);

    expect(screen.getByLabelText("Simple Food batch quantity").textContent).toContain("1");
    expect(screen.getByRole("button", { name: "Queue 1 Simple Food" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Increase Simple Food batch quantity" }));

    expect(screen.getByLabelText("Simple Food batch quantity").textContent).toContain("2");
    expect(screen.getByRole("button", { name: "Queue 2 Simple Food" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue 2 Simple Food" }));

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith("freshwater_fish", 20);
  });

  it("maps Max to the material-derived batch count without exceeding the recipe limit", () => {
    const onStart = vi.fn(() => true);
    renderPrompt(onStart, 47);

    fireEvent.click(screen.getByRole("button", { name: "Max" }));

    expect(screen.getByLabelText("Simple Food batch quantity").textContent).toContain("4");
    expect(screen.getByRole("img", { name: /^Freshwater Fish 40, have/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue 4 Simple Food" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue 4 Simple Food" }));

    expect(onStart).toHaveBeenCalledWith("freshwater_fish", 40);
  });

  it("selects Freshwater Fish on the phone prompt and sends the exact raw-input wire shape", () => {
    const sent: ClientMessage[] = [];
    const commands = new ManorClient(recordingPort(sent));
    const onStart = vi.fn((recipeId: KitchenRecipeId, quantity: number) =>
      commands.startKitchenBatch(KITCHEN_ID, recipeId, quantity) !== null
    );
    renderPrompt(onStart, 10, "freshwater_fish", "phone");

    fireEvent.click(screen.getByRole("button", { name: /Freshwater Fish/ }));
    expect(screen.getByRole("img", { name: /^Freshwater Fish 10, have/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue 1 Simple Food" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue 1 Simple Food" }));

    expect(onStart).toHaveBeenCalledWith("freshwater_fish", 10);
    expect(sent).toHaveLength(1);
    expect(clientMessageSchema.parse(sent[0])).toEqual({
      type: "START_KITCHEN_BATCH",
      requestId: expect.any(String),
      kitchenId: KITCHEN_ID,
      recipeId: "freshwater_fish",
      quantity: 10
    });
  });

  it("keeps Freshwater Fish Max at five batches and the raw recipe limit", () => {
    const onStart = vi.fn(() => true);
    renderPrompt(onStart, 99, "freshwater_fish", "phone");

    fireEvent.click(screen.getByRole("button", { name: /Freshwater Fish/ }));
    fireEvent.click(screen.getByRole("button", { name: "Max" }));

    expect(screen.getByLabelText("Simple Food batch quantity").textContent).toContain("5");
    expect(screen.getByRole("img", { name: /^Freshwater Fish 50, have/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue 5 Simple Food" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue 5 Simple Food" }));

    expect(onStart).toHaveBeenCalledWith("freshwater_fish", 50);
  });
});

function renderPrompt(
  onStart: (recipeId: KitchenRecipeId, quantity: number) => boolean,
  ownedQuantity = 30,
  inputItemId: KitchenInputId = "freshwater_fish",
  layout: "desktop" | "phone" = "desktop"
): void {
  render(<KitchenPrompt
    state={state()}
    inventory={inventory(ownedQuantity, inputItemId)}
    feedback={null}
    busy={false}
    layout={layout}
    onStart={onStart}
    onCollect={vi.fn()}
    onClose={vi.fn()}
  />);
}

function state(): KitchenStateSnapshot {
  return {
    kitchen: {
      kitchenId: "00000000-0000-4000-8000-000000000001",
      manorId: "00000000-0000-4000-8000-000000000002",
      ownerPlayerId: "player-1",
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
    serverTime: Date.UTC(2026, 0, 1)
  };
}

type KitchenInputId = "freshwater_fish";

function inventory(quantity: number, inputItemId: KitchenInputId = "freshwater_fish"): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 1,
    items: [],
    totals: { ...emptyInventoryTotals(), [inputItemId]: quantity },
    unlockedSlots: 16
  };
}

function recordingPort(sent: ClientMessage[]): ClientCommandPort {
  return {
    send(message) {
      sent.push(message);
      return { status: "sent", readiness: "ready", connectionGeneration: 1 };
    }
  };
}
