import { describe, expect, it, vi } from "vitest";

import {
  HOSTILE_SHIELDED_TARGET_MESSAGE,
  HOSTILE_UNSETTLED_ACTOR_MESSAGE,
  HostileActionGate,
  type HostileGateStore,
  type HostilePlayerStatus
} from "./hostileGate.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const FLAG_OWN = "00000000-0000-4000-8000-000000000001";
const FLAG_OTHER = "00000000-0000-4000-8000-000000000002";
const GROUP_SIEGE = "00000000-0000-4000-8000-0000000000a1";
const GROUP_INFANTRY = "00000000-0000-4000-8000-0000000000a2";
const GROUP_HOSTILE_SIEGE = "00000000-0000-4000-8000-0000000000a3";
const GROUP_FAR_SIEGE = "00000000-0000-4000-8000-0000000000a4";

function settled(accountId: string): HostilePlayerStatus {
  return { accountId, settledAt: new Date("2026-09-01T00:00:00Z"), provisionalUntil: null, devProfile: false };
}

function unsettled(accountId: string, devProfile = false): HostilePlayerStatus {
  return { accountId, settledAt: null, provisionalUntil: null, devProfile };
}

function harness(
  mode: "off" | "shadow" | "enforce",
  overrides: Partial<HostileGateStore> = {},
  devProfilesExempt = false
) {
  const statuses = new Map<string, HostilePlayerStatus>([
    ["settled-a", settled("acc-a")],
    ["settled-b", settled("acc-b")],
    ["newbie", unsettled("acc-new")],
    ["dev", unsettled("acc-dev", true)],
    ["expired", { accountId: "acc-exp", settledAt: new Date("2026-08-01T00:00:00Z"), provisionalUntil: new Date("2026-10-01T00:00:00Z"), devProfile: false }]
  ]);
  const store: HostileGateStore = {
    loadPlayerStatus: vi.fn(async (playerId: string) => statuses.get(playerId) ?? null),
    playerOwnsFlag: vi.fn(async (_playerId: string, flagId: string) => flagId === FLAG_OWN),
    militaryGroupUnitType: vi.fn(async (_playerId: string, groupId: string) =>
      groupId === GROUP_SIEGE ? "field_ballista" : groupId === GROUP_INFANTRY ? "infantry" : null),
    siegeThreatensOwnFlag: vi.fn(async (_playerId: string, groupId: string) => groupId === GROUP_HOSTILE_SIEGE),
    ...overrides
  };
  const recordSignals = vi.fn(async (input: unknown) => { void input; });
  const gate = new HostileActionGate(store, { TRUST_HOSTILE_GATE_MODE: mode }, {
    sink: { recordSignals },
    now: () => NOW,
    devProfilesExempt: () => devProfilesExempt
  });
  return { gate, store, recordSignals, statuses };
}

function rules(recordSignals: { mock: { calls: unknown[][] } }): string[] {
  return recordSignals.mock.calls.flatMap((call) =>
    (call[0] as { signals: Array<{ rule: string }> }).signals.map((signal) => signal.rule));
}

describe("HostileActionGate PvP shield", () => {
  it("refuses an unsettled attacker with actor copy and signals hostile_unsettled", async () => {
    const { gate, recordSignals } = harness("enforce");
    const decision = await gate.checkPvp({ attackerPlayerId: "newbie", targetPlayerId: "settled-a" });
    expect(decision).toEqual({
      allowed: false,
      code: "HOSTILE_UNSETTLED",
      message: HOSTILE_UNSETTLED_ACTOR_MESSAGE,
      role: "actor"
    });
    expect(rules(recordSignals)).toEqual(["hostile_unsettled"]);
    expect(HOSTILE_UNSETTLED_ACTOR_MESSAGE).not.toMatch(/\d/u);
  });

  it("refuses a Settled attacker against a shielded target with target copy", async () => {
    const { gate, recordSignals } = harness("enforce");
    const decision = await gate.checkPvp({ attackerPlayerId: "settled-a", targetPlayerId: "newbie" });
    expect(decision).toMatchObject({ allowed: false, message: HOSTILE_SHIELDED_TARGET_MESSAGE, role: "target" });
    expect(HOSTILE_SHIELDED_TARGET_MESSAGE).not.toMatch(/\d/u);
    const signal = recordSignals.mock.calls[0]![0] as unknown as { accountId: string; signals: Array<{ rule: string; weight: number }> };
    expect(signal.accountId).toBe("acc-a");
    expect(signal.signals[0]).toMatchObject({ rule: "hostile_shielded_target", weight: 0 });
  });

  it("leaves PvP between two Settled players untouched", async () => {
    const { gate, recordSignals } = harness("enforce");
    expect(await gate.checkPvp({ attackerPlayerId: "settled-a", targetPlayerId: "settled-b" })).toEqual({ allowed: true });
    await gate.checkPvp({ attackerPlayerId: "settled-b", targetPlayerId: "settled-a" });
    expect(gate.pvpBlocked("settled-a", "settled-b")).toBe(false);
    expect(recordSignals).not.toHaveBeenCalled();
  });

  it("treats an expired provisional row as unsettled", async () => {
    const { gate } = harness("enforce");
    expect((await gate.checkPvp({ attackerPlayerId: "expired", targetPlayerId: "settled-a" })).allowed).toBe(false);
  });

  it("only signals in shadow and does nothing when off", async () => {
    const shadow = harness("shadow");
    expect(await shadow.gate.checkPvp({ attackerPlayerId: "newbie", targetPlayerId: "settled-a" })).toEqual({ allowed: true });
    expect(rules(shadow.recordSignals)).toEqual(["hostile_unsettled"]);
    shadow.gate.prime("newbie");
    await vi.waitFor(() => expect(shadow.store.loadPlayerStatus).toHaveBeenCalled());
    expect(shadow.gate.pvpBlocked("newbie", "settled-a")).toBe(false);

    const off = harness("off");
    expect(await off.gate.checkPvp({ attackerPlayerId: "newbie", targetPlayerId: "settled-a" })).toEqual({ allowed: true });
    expect(off.store.loadPlayerStatus).not.toHaveBeenCalled();
  });

  it("blocks the synchronous combat path both ways once statuses are cached", async () => {
    const { gate } = harness("enforce");
    // Not cached yet: fail open while loading.
    expect(gate.pvpBlocked("settled-a", "newbie")).toBe(false);
    gate.prime("settled-a");
    await vi.waitFor(() => expect(gate.pvpBlocked("settled-a", "newbie")).toBe(true));
    expect(gate.pvpBlocked("newbie", "settled-a")).toBe(true);
    expect(gate.pvpSupportRestricted("newbie")).toBe(true);
    expect(gate.pvpSupportRestricted("settled-a")).toBe(false);
  });

  it("re-reads a player after refreshAccount (Settled gained)", async () => {
    const { gate, statuses } = harness("enforce");
    await gate.checkPvp({ attackerPlayerId: "newbie", targetPlayerId: "settled-a" });
    expect(gate.pvpBlocked("newbie", "settled-a")).toBe(true);
    statuses.set("newbie", settled("acc-new"));
    gate.refreshAccount("acc-new");
    await vi.waitFor(() => expect(gate.pvpBlocked("newbie", "settled-a")).toBe(false));
  });

  it("exempts dev profiles while developer login is enabled", async () => {
    const exempt = harness("enforce", {}, true);
    expect((await exempt.gate.checkPvp({ attackerPlayerId: "dev", targetPlayerId: "settled-a" })).allowed).toBe(true);
    const strict = harness("enforce", {}, false);
    expect((await strict.gate.checkPvp({ attackerPlayerId: "dev", targetPlayerId: "settled-a" })).allowed).toBe(false);
  });

  it("fails open when the status read fails", async () => {
    const { gate } = harness("enforce", { loadPlayerStatus: async () => { throw new Error("db down"); } });
    expect(await gate.checkPvp({ attackerPlayerId: "newbie", targetPlayerId: "settled-a" })).toEqual({ allowed: true });
  });
});

describe("HostileActionGate flags and military", () => {
  it("refuses an unsettled burn/attack on another player's flag but allows its own", async () => {
    const { gate } = harness("enforce");
    expect((await gate.checkFlagRaid({ playerId: "newbie", flagId: FLAG_OTHER, action: "flag_burn" })).allowed).toBe(false);
    expect((await gate.checkFlagRaid({ playerId: "newbie", flagId: FLAG_OTHER, action: "flag_attack" })).allowed).toBe(false);
    expect((await gate.checkFlagRaid({ playerId: "newbie", flagId: FLAG_OWN, action: "flag_attack" })).allowed).toBe(true);
    expect((await gate.checkFlagRaid({ playerId: "settled-a", flagId: FLAG_OTHER, action: "flag_burn" })).allowed).toBe(true);
  });

  it("refuses hostile military orders for unsettled accounts only", async () => {
    const { gate } = harness("enforce");
    const order = (playerId: string, o: Parameters<HostileActionGate["checkMilitaryOrder"]>[0]["order"], groupId: string) =>
      gate.checkMilitaryOrder({ playerId, order: o, groupId }).then((decision) => decision.allowed);
    expect(await order("newbie", "deploy", GROUP_SIEGE)).toBe(false);
    expect(await order("newbie", "defend", GROUP_SIEGE)).toBe(false);
    expect(await order("newbie", "deploy", GROUP_INFANTRY)).toBe(true);
    expect(await order("newbie", "fire_volley", GROUP_SIEGE)).toBe(false);
    expect(await order("newbie", "demolish_flag", GROUP_INFANTRY)).toBe(false);
    // Defending own flags against a hostile Siege stays allowed.
    expect(await order("newbie", "attack_siege", GROUP_HOSTILE_SIEGE)).toBe(true);
    expect(await order("newbie", "attack_siege", GROUP_FAR_SIEGE)).toBe(false);
    expect(await order("settled-a", "fire_volley", GROUP_SIEGE)).toBe(true);
    expect(await order("settled-a", "attack_siege", GROUP_FAR_SIEGE)).toBe(true);
  });

  it("holds automatic Siege fire for unsettled owners in enforce only", async () => {
    const enforce = harness("enforce");
    expect(await enforce.gate.automaticFireAllowed("newbie")).toBe(false);
    expect(await enforce.gate.automaticFireAllowed("expired")).toBe(false);
    expect(await enforce.gate.automaticFireAllowed("settled-a")).toBe(true);
    expect(rules(enforce.recordSignals)).toContain("hostile_unsettled");
    const shadow = harness("shadow");
    expect(await shadow.gate.automaticFireAllowed("newbie")).toBe(true);
    expect(rules(shadow.recordSignals)).toEqual(["hostile_unsettled"]);
    expect(await harness("off").gate.automaticFireAllowed("newbie")).toBe(true);
    const failing = harness("enforce", { loadPlayerStatus: async () => { throw new Error("db down"); } });
    expect(await failing.gate.automaticFireAllowed("newbie")).toBe(true);
  });
});
