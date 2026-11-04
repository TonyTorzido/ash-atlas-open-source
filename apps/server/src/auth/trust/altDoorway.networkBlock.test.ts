import { describe, expect, it, vi } from "vitest";

import {
  AltDoorwayGate,
  createSharedNetworkBlock,
  type AltDoorwayConfig,
  type AltDoorwayStore,
  type DoorwayPlayerRecord
} from "./altDoorway.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const HOST = "host-player";
const GUEST = "guest-player";
const HOST_ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const GUEST_ACCOUNT = "00000000-0000-4000-8000-0000000000b2";

function player(accountId: string, ageDays: number): DoorwayPlayerRecord {
  return {
    accountId,
    accountCreatedAt: new Date(NOW.getTime() - ageDays * DAY_MS),
    devProfile: false,
    settled: true,
    settledHome: null,
    lastFix: null,
    lastFixAssurance: null,
    lastRelocatedAt: null
  };
}

function setup(options: { hostAgeDays: number; classes: ReadonlyArray<string | null>; throws?: boolean }) {
  const players = new Map([[HOST, player(HOST_ACCOUNT, options.hostAgeDays)], [GUEST, player(GUEST_ACCOUNT, 100)]]);
  const sharedPrefixAsnClasses = vi.fn(async () => {
    if (options.throws) throw new Error("db down");
    return options.classes;
  });
  const store = {
    loadDoorwayPlayer: async (id: string) => players.get(id) ?? null,
    linkedAccounts: async () => ({ device: false, network: true }),
    sharedPrefixAsnClasses
  } as unknown as AltDoorwayStore;
  const config = {
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
  } as AltDoorwayConfig;
  const sink = { recordSignals: vi.fn(async () => undefined) };
  const gate = new AltDoorwayGate(store, config, {
    sink,
    now: () => NOW,
    sharedNetworkBlock: createSharedNetworkBlock(store, { now: () => NOW })
  });
  const check = () => gate.checkLinked({ kind: "invite", hostPlayerId: HOST, guestPlayerId: GUEST });
  return { check, sink, sharedPrefixAsnClasses };
}

describe("shared-network invite block", () => {
  it("refuses a young inviter on a shared fixed-line network", async () => {
    const t = setup({ hostAgeDays: 5, classes: ["fixed"] });
    expect(await t.check()).toMatchObject({ allowed: false, code: "TRAVEL_LINKED_ACCOUNT" });
    expect(t.sink.recordSignals).toHaveBeenCalled();
  });

  it("refuses when the shared prefix ASN is unknown or never recorded", async () => {
    expect(await setup({ hostAgeDays: 5, classes: ["unknown"] }).check()).toMatchObject({ allowed: false });
    expect(await setup({ hostAgeDays: 5, classes: [null] }).check()).toMatchObject({ allowed: false });
  });

  it("only signals when the shared prefix is mobile", async () => {
    const t = setup({ hostAgeDays: 5, classes: ["mobile"] });
    expect(await t.check()).toEqual({ allowed: true });
    expect(t.sink.recordSignals).toHaveBeenCalled();
  });

  it("refuses when any shared prefix is not mobile", async () => {
    expect(await setup({ hostAgeDays: 5, classes: ["mobile", "fixed"] }).check()).toMatchObject({ allowed: false });
  });

  it("never blocks an established inviter", async () => {
    const t = setup({ hostAgeDays: 45, classes: ["fixed"] });
    expect(await t.check()).toEqual({ allowed: true });
    expect(t.sharedPrefixAsnClasses).not.toHaveBeenCalled();
  });

  it("fails open when the lookup errors", async () => {
    expect(await setup({ hostAgeDays: 5, classes: [], throws: true }).check()).toEqual({ allowed: true });
  });
});
