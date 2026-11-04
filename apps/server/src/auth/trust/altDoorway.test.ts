import { describe, expect, it, vi } from "vitest";

import {
  AltDoorwayGate,
  DOORWAY_UNSETTLED_INVITE_MESSAGE,
  DOORWAY_UNSETTLED_PARTY_MESSAGE,
  DOORWAY_WEB_INVITE_MESSAGE,
  type AltDoorwayConfig,
  type AltDoorwayStore,
  type DoorwayDestination,
  type DoorwayPlayerRecord
} from "./altDoorway.js";
import { LocationReportService, type TrustSignalSink } from "./trustService.js";
import type { AccountLocationState, LocationReportStore } from "./trustStore.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const HOST = "host-player";
const GUEST = "guest-player";
const HOST_ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const GUEST_ACCOUNT = "00000000-0000-4000-8000-0000000000b2";
const OWN_FLAG = "11111111-1111-4111-8111-111111111111";
const OTHER_FLAG = "22222222-2222-4222-8222-222222222222";
const FAR_FLAG = "33333333-3333-4333-8333-333333333333";
const POSITION = { lat: 40, lon: -105 };
const HOME = { lat: 40.05, lon: -105 };

function player(overrides: Partial<DoorwayPlayerRecord> = {}): DoorwayPlayerRecord {
  return {
    accountId: HOST_ACCOUNT,
    accountCreatedAt: new Date(NOW.getTime() - 30 * DAY_MS),
    devProfile: false,
    settled: true,
    settledHome: HOME,
    lastFix: { lat: 40.01, lon: -105.01, at: new Date(NOW.getTime() - 120_000) },
    lastFixAssurance: "native_legacy",
    lastRelocatedAt: null,
    ...overrides
  };
}

class FakeDoorwayStore implements AltDoorwayStore {
  players = new Map<string, DoorwayPlayerRecord>([
    [HOST, player()],
    [GUEST, player({ accountId: GUEST_ACCOUNT })]
  ]);
  linked = { device: false, network: false };
  // Flags owned by HOST: OWN_FLAG near the Settled home, FAR_FLAG 200 km away.
  ownedDestinations = new Map<string, { lat: number; lon: number }>([
    [OWN_FLAG, { lat: 40.2, lon: -105 }],
    [FAR_FLAG, { lat: 41.8, lon: -105 }]
  ]);
  arrivalHolds = new Map<string, Date>();
  devAccounts = new Set<string>();

  async loadDoorwayPlayer(playerId: string) {
    return this.players.get(playerId) ?? null;
  }

  async ownedDestinationPosition(playerId: string, destination: { id: string }) {
    return playerId === HOST ? this.ownedDestinations.get(destination.id) ?? null : null;
  }

  async linkedAccounts() {
    return this.linked;
  }

  async loadArrivalHold(playerId: string) {
    return this.arrivalHolds.get(playerId) ?? null;
  }

  async setArrivalHold(playerId: string, until: Date) {
    this.arrivalHolds.set(playerId, until);
  }

  async playerOwnsFlag(_playerId: string, flagId: string) {
    return flagId === OWN_FLAG;
  }

  async isDevProfile(accountId: string) {
    return this.devAccounts.has(accountId);
  }
}

function config(overrides: Partial<AltDoorwayConfig> = {}): AltDoorwayConfig {
  return {
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
    TRUST_LINKED_ALT_MODE: "enforce",
    ...overrides
  };
}

function setup(overrides: Partial<AltDoorwayConfig> = {}, devProfilesExempt = false) {
  const store = new FakeDoorwayStore();
  const sink = { recordSignals: vi.fn<TrustSignalSink["recordSignals"]>(async () => undefined) };
  let now = NOW;
  const gate = new AltDoorwayGate(store, config(overrides), {
    sink,
    now: () => now,
    devProfilesExempt: () => devProfilesExempt
  });
  const rules = () => sink.recordSignals.mock.calls.map(([call]) => call.signals[0]!.rule);
  return { store, sink, gate, rules, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const world: DoorwayDestination = { kind: "world" };
const invite = (destination: DoorwayDestination = world) => ({
  kind: "invite" as const,
  hostPlayerId: HOST,
  guestPlayerId: GUEST,
  hostPosition: POSITION,
  destination
});

describe("AltDoorwayGate Settled", () => {
  it("allows a Settled, present inviter", async () => {
    const { gate, sink } = setup();
    expect(await gate.check(invite())).toEqual({ allowed: true });
    expect(sink.recordSignals).not.toHaveBeenCalled();
  });

  it("refuses an unsettled host with numberless copy and no retry hint", async () => {
    const { gate, store, rules } = setup();
    store.players.set(HOST, player({ settled: false, settledHome: null }));
    const decision = await gate.check(invite());
    expect(decision).toEqual({
      allowed: false,
      code: "TRAVEL_DOORWAY_UNCONFIRMED",
      message: DOORWAY_UNSETTLED_INVITE_MESSAGE
    });
    expect(await gate.checkHost({ ...invite(), kind: "party_manual" })).toMatchObject({
      message: DOORWAY_UNSETTLED_PARTY_MESSAGE
    });
    expect(await gate.checkHost({ ...invite(), hostClientPlatform: "web" })).toMatchObject({
      message: DOORWAY_WEB_INVITE_MESSAGE
    });
    for (const message of [DOORWAY_UNSETTLED_INVITE_MESSAGE, DOORWAY_UNSETTLED_PARTY_MESSAGE, DOORWAY_WEB_INVITE_MESSAGE]) {
      expect(message).not.toMatch(/\d/u);
    }
    expect(rules()).toContain("doorway_unconfirmed");
  });

  it("exempts dev profiles only while developer login is enabled", async () => {
    const enabled = setup({}, true);
    enabled.store.players.set(HOST, player({ devProfile: true, settled: false, lastFix: null }));
    expect(await enabled.gate.checkHost(invite())).toEqual({ allowed: true });
    const disabled = setup({}, false);
    disabled.store.players.set(HOST, player({ devProfile: true, settled: false }));
    expect(await disabled.gate.checkHost(invite())).toMatchObject({ allowed: false });
  });

  it.each([
    ["off", true, []],
    ["shadow", true, ["doorway_unconfirmed"]],
    ["enforce", false, ["doorway_unconfirmed"]]
  ] as const)("applies TRUST_SETTLED_GATE_MODE=%s", async (mode, allowed, signals) => {
    const { gate, store, rules } = setup({ TRUST_SETTLED_GATE_MODE: mode });
    store.players.set(HOST, player({ settled: false }));
    expect((await gate.checkHost(invite())).allowed).toBe(allowed);
    expect(rules()).toEqual(signals);
  });

  it("never enforces Settled while the doorway master switch is shadow", async () => {
    const { gate, store, rules } = setup({ TRUST_DOORWAY_MODE: "shadow" });
    store.players.set(HOST, player({ settled: false }));
    expect(await gate.checkHost(invite())).toEqual({ allowed: true });
    expect(rules()).toEqual(["doorway_unconfirmed"]);
  });
});

describe("AltDoorwayGate presence", () => {
  it("refuses a stale fix and a far fix", async () => {
    const { gate, store, rules } = setup();
    store.players.set(HOST, player({ lastFix: { ...POSITION, at: new Date(NOW.getTime() - 11 * 60_000) } }));
    expect(await gate.checkHost(invite())).toMatchObject({
      allowed: false,
      code: "TRAVEL_DOORWAY_NO_PRESENCE",
      message: expect.stringContaining("Keep Ash Atlas open with location on")
    });
    store.players.set(HOST, player({ lastFix: { lat: 41, lon: -105, at: NOW } }));
    expect(await gate.checkHost(invite())).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_NO_PRESENCE" });
    store.players.set(HOST, player({ lastFix: null }));
    expect(await gate.checkHost(invite())).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_NO_PRESENCE" });
    expect(rules()).toEqual(["doorway_no_presence", "doorway_no_presence", "doorway_no_presence"]);
  });

  it("needs a native fix: web never, legacy shells only in shadow assurance", async () => {
    const shadow = setup();
    shadow.store.players.set(HOST, player({ lastFixAssurance: "web" }));
    expect(await shadow.gate.checkHost(invite())).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_NO_PRESENCE" });
    shadow.store.players.set(HOST, player({ lastFixAssurance: null }));
    expect((await shadow.gate.checkHost(invite())).allowed).toBe(false);
    shadow.store.players.set(HOST, player({ lastFixAssurance: "native_legacy" }));
    expect(await shadow.gate.checkHost(invite())).toEqual({ allowed: true });

    const enforce = setup({ TRUST_SETTLE_ASSURANCE_MODE: "enforce" });
    enforce.store.players.set(HOST, player({ lastFixAssurance: "native_legacy" }));
    expect((await enforce.gate.checkHost(invite())).allowed).toBe(false);
    enforce.store.players.set(HOST, player({ lastFixAssurance: "attested" }));
    expect(await enforce.gate.checkHost(invite())).toEqual({ allowed: true });
    enforce.store.players.set(HOST, player({ lastFixAssurance: "device_checked" }));
    expect(await enforce.gate.checkHost(invite())).toEqual({ allowed: true });
  });

  it("tells a web inviter to open the phone app", async () => {
    const { gate, store } = setup();
    store.players.set(HOST, player({ lastFixAssurance: "web" }));
    expect(await gate.checkHost({ ...invite(), hostClientPlatform: "web" })).toEqual({
      allowed: false,
      code: "TRAVEL_DOORWAY_NO_PRESENCE",
      message: DOORWAY_WEB_INVITE_MESSAGE
    });
  });

  it("exempts only the Settled host's own destinations near the Settled home", async () => {
    const { gate, store } = setup();
    store.players.set(HOST, player({ lastFix: null }));
    expect(await gate.checkHost(invite({ kind: "flag", id: OWN_FLAG }))).toEqual({ allowed: true });
    expect(await gate.checkHost(invite({ kind: "manor", ownerPlayerId: HOST }))).toEqual({ allowed: true });
    // Owned but far from the Settled home, not owned, someone else's manor.
    expect((await gate.checkHost(invite({ kind: "flag", id: FAR_FLAG }))).allowed).toBe(false);
    expect((await gate.checkHost(invite({ kind: "flag", id: OTHER_FLAG }))).allowed).toBe(false);
    expect((await gate.checkHost(invite({ kind: "manor", ownerPlayerId: GUEST }))).allowed).toBe(false);
    // Unsettled in shadow: the Settled gate only signals, and the exemption is gone.
    const shadow = setup({ TRUST_SETTLED_GATE_MODE: "shadow" });
    shadow.store.players.set(HOST, player({ lastFix: null, settled: false }));
    expect((await shadow.gate.checkHost(invite({ kind: "flag", id: OWN_FLAG }))).allowed).toBe(false);
  });
});

describe("AltDoorwayGate invite chain", () => {
  it("A (Settled, present) brings B; B at the spot cannot bring C", async () => {
    const { gate, store } = setup();
    // A invites B from home: allowed.
    expect(await gate.check(invite())).toEqual({ allowed: true });
    // B arrived at A's spot and places a flag there (land actions never wait).
    const spot = { lat: 40.01, lon: -105.01 };
    store.ownedDestinations.clear();
    const bFlag = "44444444-4444-4444-8444-444444444444";
    const fakeB = "player-b";
    store.ownedDestinations.set(bFlag, spot);
    // B is not Settled there: refused.
    store.players.set(fakeB, player({
      accountId: GUEST_ACCOUNT, settled: false, settledHome: null, lastFix: null, lastFixAssurance: null
    }));
    const chain = (destination: DoorwayDestination) => gate.checkHost({
      kind: "invite", hostPlayerId: fakeB, hostPosition: spot, destination
    });
    expect(await chain({ kind: "flag", id: bFlag })).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_UNCONFIRMED" });
    // Even Settled far away at home, B has no native fix at the spot and the
    // new flag is not anchored near B's Settled home.
    store.players.set(fakeB, player({
      accountId: GUEST_ACCOUNT, settled: true, settledHome: { lat: 34, lon: -118 }, lastFix: null
    }));
    expect(await chain({ kind: "flag", id: bFlag })).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_NO_PRESENCE" });
    expect(await chain(world)).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_NO_PRESENCE" });
  });
});

describe("AltDoorwayGate party relocation shortcut", () => {
  it("refuses party travel to a leader who relocated within the hour, in every mode", async () => {
    for (const mode of ["off", "shadow", "enforce"] as const) {
      const { gate, store } = setup({ TRUST_DOORWAY_MODE: mode });
      store.players.set(HOST, player({ lastRelocatedAt: new Date(NOW.getTime() - 20 * 60_000) }));
      for (const kind of ["party_manual", "party_auto_follow"] as const) {
        expect(await gate.checkHost({ ...invite(), kind })).toEqual({
          allowed: false,
          code: "PARTY_TRAVEL_RELOCATION_COOLDOWN",
          message: "Your party leader just relocated. Party Travel opens in 40 minutes.",
          retryAfterMs: 40 * 60_000
        });
      }
      // Invites keep their own cooldown in TravelInviteService.send.
      expect(await gate.checkHost(invite())).toEqual({ allowed: true });
    }
  });

  it("allows party travel once the hour has passed", async () => {
    const { gate, store } = setup();
    store.players.set(HOST, player({ lastRelocatedAt: new Date(NOW.getTime() - 61 * 60_000) }));
    expect(await gate.checkHost({ ...invite(), kind: "party_manual" })).toEqual({ allowed: true });
  });
});

describe("AltDoorwayGate linked alts", () => {
  it("blocks a shared device and signals both accounts", async () => {
    const { gate, store, sink } = setup();
    store.linked = { device: true, network: true };
    expect(await gate.check(invite())).toMatchObject({ allowed: false, code: "TRAVEL_LINKED_ACCOUNT" });
    const calls = sink.recordSignals.mock.calls.map(([call]) =>
      [call.accountId, call.signals[0]!.rule, call.signals[0]!.metadata?.dedupeKey]);
    expect(calls).toEqual([
      [HOST_ACCOUNT, "linked_network", `linked_network:${HOST_ACCOUNT}:${GUEST_ACCOUNT}:2026-10-01`],
      [GUEST_ACCOUNT, "linked_network", `linked_network:${GUEST_ACCOUNT}:${HOST_ACCOUNT}:2026-10-01`],
      [HOST_ACCOUNT, "linked_device", `linked_device:${HOST_ACCOUNT}:${GUEST_ACCOUNT}:2026-10-01`],
      [GUEST_ACCOUNT, "linked_device", `linked_device:${GUEST_ACCOUNT}:${HOST_ACCOUNT}:2026-10-01`]
    ]);
  });

  it("only signals a shared network prefix", async () => {
    const { gate, store, rules } = setup();
    store.linked = { device: false, network: true };
    expect(await gate.checkLinked({ ...invite(), kind: "party_auto_follow" })).toEqual({ allowed: true });
    expect(rules()).toEqual(["linked_network", "linked_network"]);
  });

  it("allows a shared device in shadow mode and skips checks when off", async () => {
    const shadow = setup({ TRUST_LINKED_ALT_MODE: "shadow" });
    shadow.store.linked = { device: true, network: false };
    expect(await shadow.gate.checkLinked(invite())).toEqual({ allowed: true });
    expect(shadow.rules()).toEqual(["linked_device", "linked_device"]);
    const off = setup({ TRUST_LINKED_ALT_MODE: "off" });
    off.store.linked = { device: true, network: true };
    expect(await off.gate.checkLinked(invite())).toEqual({ allowed: true });
    expect(off.rules()).toEqual([]);
  });
});

describe("AltDoorwayGate arrival raid hold", () => {
  const raid = (flagId = OTHER_FLAG) => ({
    accountId: GUEST_ACCOUNT,
    playerId: GUEST,
    action: "flag_burn" as const,
    flagId
  });

  it("blocks raids on other flags for the hold, then allows them", async () => {
    const { gate, store, advance, rules } = setup();
    expect(await gate.checkRaid(raid())).toEqual({ allowed: true });
    gate.noteArrival(GUEST);
    await vi.waitFor(() => expect(store.arrivalHolds.get(GUEST)).toEqual(new Date(NOW.getTime() + 60 * 60_000)));
    expect(await gate.checkRaid(raid())).toEqual({
      allowed: false,
      code: "ARRIVAL_RAID_HOLD",
      message: "You just arrived — you can raid flags in 60 minutes.",
      retryAfterMs: 60 * 60_000
    });
    expect(await gate.checkRaid({ ...raid(), action: "flag_attack" })).toMatchObject({ allowed: false });
    expect(await gate.checkRaid(raid(OWN_FLAG))).toEqual({ allowed: true });
    advance(59 * 60_000);
    expect(await gate.checkRaid(raid())).toMatchObject({ allowed: false, message: expect.stringContaining("in 1 minute.") });
    advance(60_000);
    expect(await gate.checkRaid(raid())).toEqual({ allowed: true });
    expect(new Set(rules())).toEqual(new Set(["arrival_raid_blocked"]));
  });

  it("holds arrivals brought by a young inviter for the young-inviter window", async () => {
    const { gate, store } = setup();
    store.players.set(HOST, player({ accountCreatedAt: new Date(NOW.getTime() - 10 * DAY_MS) }));
    gate.noteArrival(GUEST, HOST);
    await vi.waitFor(() => expect(store.arrivalHolds.get(GUEST)).toEqual(new Date(NOW.getTime() + 1440 * 60_000)));
    expect(await gate.checkRaid(raid())).toMatchObject({ allowed: false, retryAfterMs: 1440 * 60_000 });
    // An older inviter keeps the ordinary hold.
    const old = setup();
    old.gate.noteArrival(GUEST, HOST);
    await vi.waitFor(() => expect(old.store.arrivalHolds.get(GUEST)).toEqual(new Date(NOW.getTime() + 60 * 60_000)));
  });

  it("hydrates a persisted hold for a new process", async () => {
    const { gate, store } = setup();
    store.arrivalHolds.set(GUEST, new Date(NOW.getTime() + 10 * 60_000));
    expect(await gate.checkRaid(raid())).toMatchObject({ allowed: false, retryAfterMs: 10 * 60_000 });
  });

  it("allows with a signal in shadow mode and records nothing when off", async () => {
    const shadow = setup({ TRUST_ARRIVAL_RAID_MODE: "shadow" });
    shadow.gate.noteArrival(GUEST);
    expect(await shadow.gate.checkRaid(raid())).toEqual({ allowed: true });
    expect(shadow.rules()).toEqual(["arrival_raid_blocked"]);
    const off = setup({ TRUST_ARRIVAL_RAID_MODE: "off" });
    off.gate.noteArrival(GUEST);
    expect(await off.gate.checkRaid(raid())).toEqual({ allowed: true });
    expect(off.store.arrivalHolds.size).toBe(0);
  });
});

describe("LocationReportService presence days", () => {
  function service(state: Partial<AccountLocationState>) {
    const store: LocationReportStore = {
      loadLocationContext: async () => ({
        state: {
          accountId: HOST_ACCOUNT,
          lastSeq: 1,
          lastAcceptedReportId: null,
          lastFix: { ...POSITION, accuracyM: 10, at: new Date(NOW.getTime() - 300_000) },
          lastLandAction: null,
          landActionHoldUntil: null,
          landActionHoldReason: null,
          relocations7dFar: 0,
          ...state
        },
        farRelocationsSince: 0
      }),
      recordLocationReport: async () => ({ reportId: "r", seq: 2 }),
      updateLastFix: async () => undefined,
      deleteLocationReportsBefore: async () => 0
    };
    return new LocationReportService(store, {
      TRUST_LOCATION_REJECT_MODE: "shadow",
      TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
      TRUST_TRANSIT_HOLD_MINUTES: 10,
      TRUST_SETTLE_ACCURACY_M: 5000,
      TRUST_PRESENCE_RADIUS_KM: 25
    }, { now: () => NOW });
  }
  const passive = (lat: number) => ({
    accountId: HOST_ACCOUNT,
    playerId: HOST,
    source: "passive" as const,
    lat,
    lon: -105,
    accuracyM: 10,
    deviceInstallationId: null,
    networkHash: null,
    networkPrefixHash: null,
    avatarPosition: null
  });

  it("confirms the UTC day only for passive fixes within the radius of home", async () => {
    const near = service({ home: { lat: 40.1, lon: -105, source: "relocation" } });
    expect((await near.evaluate(passive(40))).presenceDay).toBe("2026-10-01");
    expect((await near.evaluate({ ...passive(40), source: "relocation" })).presenceDay).toBeNull();
    const far = service({ home: { lat: 41, lon: -105, source: "passive" } });
    expect((await far.evaluate(passive(40))).presenceDay).toBeNull();
    // With no home yet, the first passive fix becomes home and confirms its day.
    const noHome = service({ home: null });
    expect((await noHome.evaluate(passive(40))).presenceDay).toBe("2026-10-01");
    expect((await noHome.evaluate({ ...passive(40), source: "relocation" })).presenceDay).toBeNull();
  });
});
