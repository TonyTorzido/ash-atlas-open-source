import { describe, expect, it, vi } from "vitest";

import { AltDoorwayGate, type AltDoorwayStore } from "../../auth/trust/altDoorway.js";
import { LandActionGate } from "../../auth/trust/trustService.js";
import type { LandActionHold, LandActionRecord, LandActionStore } from "../../auth/trust/trustStore.js";
import { createFlagHandler, type FlagHandlerContext } from "./flagHandler.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

class FakeLandActionStore implements LandActionStore {
  hold: LandActionHold = { holdUntil: null, holdReason: null };
  records: LandActionRecord[] = [];

  async loadLandActionHold(): Promise<LandActionHold> {
    return this.hold;
  }

  async recordLandAction(record: LandActionRecord): Promise<void> {
    this.records.push(record);
  }
}

function flagContext(store: FakeLandActionStore, mode: "shadow" | "enforce") {
  const player = { playerId: "player-1", position: { lat: 40, lon: -105 } };
  const flagBuilds = { start: vi.fn(async () => undefined) };
  const sendCombatError = vi.fn();
  const context = {
    state: { playerId: player.playerId },
    logger: { info: vi.fn(), warn: vi.fn() },
    socket: {},
    gameState: { getPlayer: vi.fn(() => player) },
    flagBuilds,
    flagHardenings: {},
    flagService: {},
    authenticatedSession: { account: { id: ACCOUNT } },
    landActions: new LandActionGate(store, { TRUST_LAND_ACTION_MODE: mode }),
    broadcastFlagUpdate: vi.fn(),
    rejectDuringPlayerWorldTransition: vi.fn(() => false),
    sendCombatError
  } as unknown as FlagHandlerContext;
  return { handler: createFlagHandler(context), flagBuilds, sendCombatError };
}

const placeFlag = {
  type: "PLACE_FLAG" as const,
  requestId: "place-1",
  name: "Northwatch"
};

describe("flag placement land-action gate", () => {
  it("allows placement with no hold in enforce mode and records the land action", async () => {
    const store = new FakeLandActionStore();
    const { handler, flagBuilds, sendCombatError } = flagContext(store, "enforce");

    await handler(placeFlag as never);

    expect(flagBuilds.start).toHaveBeenCalledOnce();
    expect(sendCombatError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.records).toHaveLength(1));
    expect(store.records[0]).toMatchObject({ accountId: ACCOUNT, lat: 40, lon: -105, regionCell: "80:-210" });
  });

  it("refuses placement during an enforced hold with a retryable settling error", async () => {
    const store = new FakeLandActionStore();
    store.hold = { holdUntil: new Date(Date.now() + 10 * 60_000), holdReason: "transit" };
    const { handler, flagBuilds, sendCombatError } = flagContext(store, "enforce");

    await handler(placeFlag as never);

    expect(flagBuilds.start).not.toHaveBeenCalled();
    expect(sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      "place-1",
      "LAND_ACTION_SETTLING",
      "Try again later.",
      { retryable: true, retryAfterMs: expect.any(Number) }
    );
    const retryAfterMs = sendCombatError.mock.calls[0]![4].retryAfterMs as number;
    expect(retryAfterMs).toBeGreaterThan(9 * 60_000);
    expect(retryAfterMs).toBeLessThanOrEqual(10 * 60_000);
    expect(store.records).toEqual([]);
  });

  it("lets placement through during a shadow hold", async () => {
    const store = new FakeLandActionStore();
    store.hold = { holdUntil: new Date(Date.now() + 10 * 60_000), holdReason: "transit" };
    const { handler, flagBuilds, sendCombatError } = flagContext(store, "shadow");

    await handler(placeFlag as never);

    expect(flagBuilds.start).toHaveBeenCalledOnce();
    expect(sendCombatError).not.toHaveBeenCalled();
  });
});

describe("flag raid arrival hold", () => {
  const OWN_FLAG = "11111111-1111-4111-8111-111111111111";
  const ENEMY_FLAG = "22222222-2222-4222-8222-222222222222";

  function raidContext() {
    const holds = new Map<string, Date>();
    const store = {
      loadArrivalHold: async (playerId: string) => holds.get(playerId) ?? null,
      setArrivalHold: async (playerId: string, until: Date) => { holds.set(playerId, until); },
      playerOwnsFlag: async (_playerId: string, flagId: string) => flagId === OWN_FLAG,
      isDevProfile: async () => false
    } as unknown as AltDoorwayStore;
    const altDoorway = new AltDoorwayGate(store, {
      TRUST_DOORWAY_MODE: "enforce",
      TRUST_SETTLED_GATE_MODE: "enforce",
      TRUST_SETTLE_ASSURANCE_MODE: "shadow",
      TRUST_HOME_DESTINATION_RADIUS_KM: 50,
      TRUST_YOUNG_INVITER_DAYS: 30,
      TRUST_YOUNG_INVITER_ARRIVAL_HOLD_MINUTES: 1440,
      TRUST_PRESENCE_RADIUS_KM: 25,
      TRUST_PRESENCE_MAX_FIX_AGE_SECONDS: 600,
      TRUST_ARRIVAL_RAID_MODE: "enforce",
      TRUST_ARRIVAL_RAID_HOLD_MINUTES: 60,
      TRUST_LINKED_ALT_MODE: "enforce"
    });
    const player = { playerId: "player-1", position: { lat: 40, lon: -105 } };
    const flagBurns = { start: vi.fn(async () => ({})) };
    const flagService = { attackFlag: vi.fn(async () => ({ flag: {} })) };
    const sendCombatError = vi.fn();
    const context = {
      state: { playerId: player.playerId },
      logger: { info: vi.fn(), warn: vi.fn() },
      socket: {},
      gameState: { getPlayer: vi.fn(() => player) },
      flagBuilds: null,
      flagHardenings: {},
      flagBurns,
      flagService,
      authenticatedSession: { account: { id: ACCOUNT } },
      altDoorway,
      broadcastFlagUpdate: vi.fn(),
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      sendCombatError
    } as unknown as FlagHandlerContext;
    return { handler: createFlagHandler(context), altDoorway, flagBurns, flagService, sendCombatError };
  }

  it("refuses burns and attacks on other flags right after arriving, not on own flags", async () => {
    const { handler, altDoorway, flagBurns, flagService, sendCombatError } = raidContext();
    await handler({ type: "START_FLAG_BURN", requestId: "burn-0", flagId: ENEMY_FLAG } as never);
    expect(flagBurns.start).toHaveBeenCalledOnce();

    altDoorway.noteArrival("player-1");
    await handler({ type: "START_FLAG_BURN", requestId: "burn-1", flagId: ENEMY_FLAG } as never);
    await handler({ type: "ATTACK_FLAG", requestId: "attack-1", flagId: ENEMY_FLAG } as never);
    expect(flagBurns.start).toHaveBeenCalledOnce();
    expect(flagService.attackFlag).not.toHaveBeenCalled();
    expect(sendCombatError.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["burn-1", "ARRIVAL_RAID_HOLD"],
      ["attack-1", "ARRIVAL_RAID_HOLD"]
    ]);
    expect(sendCombatError.mock.calls[0]![3]).toBe("You just arrived — you can raid flags in 60 minutes.");
    expect(sendCombatError.mock.calls[0]![4]).toEqual({ retryable: true, retryAfterMs: expect.any(Number) });

    await handler({ type: "ATTACK_FLAG", requestId: "attack-own", flagId: OWN_FLAG } as never);
    expect(flagService.attackFlag).toHaveBeenCalledOnce();
  });
});
