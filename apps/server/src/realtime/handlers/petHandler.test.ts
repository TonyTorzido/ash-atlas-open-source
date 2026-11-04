import type { PetStateSnapshot, ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../../auth/types.js";
import type { PetCompanionRuntime } from "../../game/combat/petCompanionRuntime.js";
import type { PetMutationResult, PetService } from "../../game/petService.js";
import type { SocketLike } from "../connectionRegistry.js";
import { createPetHandler } from "./petHandler.js";

const PET_ID = "11111111-1111-4111-8111-111111111111";
const state: PetStateSnapshot = {
  pets: [], activePetId: null, gearCapLevel: 0, eggs: [], healItemQuantity: 0, hermitOffers: [],
  serverTime: "2026-10-03T12:00:00.000Z"
};
const result: PetMutationResult = { state, active: null, notice: "Rex is out." };

describe("pet handler", () => {
  it("calls a pet out, syncs the companion, and replies with the state", async () => {
    const harness = createHarness();
    await harness.handler({ type: "CALL_PET", requestId: "call-1", petId: PET_ID });
    expect(harness.pets.call).toHaveBeenCalledWith({ accountId: "account-1", playerId: "player-1" }, PET_ID);
    expect(harness.companions.sync).toHaveBeenCalledWith("player-1", null);
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_STATE", requestId: "call-1", action: "call", notice: "Rex is out." });
  });

  it("refuses to call a pet inside a dungeon", async () => {
    const harness = createHarness({ inDungeon: true });
    await harness.handler({ type: "CALL_PET", requestId: "call-2", petId: PET_ID });
    expect(harness.pets.call).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_ERROR", requestId: "call-2", code: "PET_DUNGEON" });
  });

  it("passes Stay to the runtime and rejects commands for a pet that is not out", async () => {
    const harness = createHarness();
    await harness.handler({ type: "COMMAND_PET", requestId: "cmd-1", petId: PET_ID, command: "stay" });
    expect(harness.companions.command).toHaveBeenCalledWith("player-1", PET_ID, "stay");
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_STATE", action: "command" });
    harness.companions.command.mockReturnValue(false);
    await harness.handler({ type: "COMMAND_PET", requestId: "cmd-2", petId: PET_ID, command: "follow" });
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_ERROR", code: "INVALID_PET_STATE" });
  });
});

describe("drag-to-place Stay", () => {
  it("sends the spot to the runtime and echoes the accepted spot", async () => {
    const harness = createHarness();
    const spot = { lat: 35.09, lon: -106.65 };
    harness.companions.stayAt.mockReturnValue(spot);
    await harness.handler({ type: "COMMAND_PET", requestId: "place-1", petId: PET_ID, command: "stay", destination: spot });
    expect(harness.companions.placeStay).toHaveBeenCalledWith("player-1", PET_ID, spot);
    expect(harness.companions.command).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_STATE", requestId: "place-1", action: "command", stayAt: spot });
  });

  it("rejects a spot sent with Follow and passes runtime refusals through", async () => {
    const harness = createHarness();
    await harness.handler({ type: "COMMAND_PET", requestId: "place-2", petId: PET_ID, command: "follow", destination: { lat: 35, lon: -106 } });
    expect(harness.companions.placeStay).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_ERROR", requestId: "place-2" });
    const { PetAbilityError } = await import("../../game/combat/petCompanionRuntime.js");
    harness.companions.placeStay.mockImplementation(() => { throw new PetAbilityError("PET_STAY_SPOT_TOO_FAR", "Place your pet within 1 km of you."); });
    await harness.handler({ type: "COMMAND_PET", requestId: "place-3", petId: PET_ID, command: "stay", destination: { lat: 36, lon: -106 } });
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_ERROR", requestId: "place-3", code: "PET_STAY_SPOT_TOO_FAR" });
  });
});

describe("developer pet grant", () => {
  it("grants every pet to a developer", async () => {
    const harness = createHarness({ developer: true });
    await harness.handler({ type: "GRANT_OWN_DEV_PETS", requestId: "dev-1" });
    expect(harness.pets.grantAllForDeveloper).toHaveBeenCalledWith({ accountId: "account-1", playerId: "player-1" });
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_STATE", requestId: "dev-1", action: "dev_grant" });
  });

  it("denies a player without the developer capability", async () => {
    const harness = createHarness({ developer: false });
    await harness.handler({ type: "GRANT_OWN_DEV_PETS", requestId: "dev-2" });
    expect(harness.pets.grantAllForDeveloper).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toMatchObject({ type: "PET_ERROR", requestId: "dev-2", code: "DEVELOPER_COMMAND_FORBIDDEN" });
  });
});

function createHarness(options: { inDungeon?: boolean; developer?: boolean } = {}) {
  const pets = {
    state: vi.fn(async () => result),
    call: vi.fn(async () => result),
    grantAllForDeveloper: vi.fn(async () => result)
  };
  const companions = {
    sync: vi.fn(),
    update: vi.fn(),
    command: vi.fn(() => true),
    placeStay: vi.fn((_player: string, _pet: string, destination: { lat: number; lon: number }) => destination),
    stayAt: vi.fn((): { lat: number; lon: number } | null => null),
    abilityReadyAt: vi.fn(() => ({})),
    isOwnerInDungeon: vi.fn(() => options.inDungeon === true)
  };
  const sent: ServerMessage[] = [];
  const handler = createPetHandler({
    state: { playerId: "player-1" },
    socket: {} as SocketLike,
    authenticatedSession: { account: { id: "account-1" } } as AuthenticatedSession,
    pets: pets as unknown as PetService,
    petCompanions: companions as unknown as PetCompanionRuntime,
    authorizeDeveloperGrant: vi.fn(async () => options.developer === true),
    sendCombatScopeSnapshot: vi.fn(),
    safeSendServerMessage: (_socket, message) => { sent.push(message); return true; }
  });
  return { handler, pets, companions, sent };
}
