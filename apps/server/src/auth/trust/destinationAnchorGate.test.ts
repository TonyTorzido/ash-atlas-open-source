import { describe, expect, it, vi } from "vitest";

import {
  DESTINATION_UNANCHORED_MESSAGE,
  DestinationAnchorGate,
  PRIVATE_UNTIL_SETTLED_MESSAGE,
  anchorDestinationRef,
  type AnchorPlayerStatus,
  type DestinationAnchorStore,
  type ResolvedAnchorDestination
} from "./destinationAnchorGate.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const FLAG = "00000000-0000-4000-8000-000000000001";
const PRIVATE_FLAG = "00000000-0000-4000-8000-000000000002";
const CITY = "00000000-0000-4000-8000-000000000003";
const SEAT = "00000000-0000-4000-8000-000000000004";
const CITY_FLAG = "00000000-0000-4000-8000-000000000005";

function destination(overrides: Partial<ResolvedAnchorDestination> = {}): ResolvedAnchorDestination {
  return {
    kind: "flag",
    id: FLAG,
    anchorPlayerId: "owner",
    anchorAccountId: "acc-owner",
    ownerPlayerId: "owner",
    anchorDevProfile: false,
    lat: 40,
    lon: -105,
    openToOthers: true,
    personalFlag: true,
    ...overrides
  };
}

function harness(mode: "off" | "shadow" | "enforce", anchored = false) {
  const statuses = new Map<string, AnchorPlayerStatus>([
    ["owner", { accountId: "acc-owner", settledAt: null, provisionalUntil: null, devProfile: false }],
    ["stranger", { accountId: "acc-stranger", settledAt: null, provisionalUntil: null, devProfile: false }],
    ["settled", { accountId: "acc-settled", settledAt: new Date("2026-09-01T00:00:00Z"), provisionalUntil: null, devProfile: false }]
  ]);
  const store: DestinationAnchorStore = {
    resolveDestination: vi.fn(async (ref) => {
      if (ref.kind === "city") {
        return destination({ kind: "city", id: CITY, anchorPlayerId: "founder", ownerPlayerId: "founder", personalFlag: false });
      }
      if (ref.id === PRIVATE_FLAG) return destination({ id: PRIVATE_FLAG, openToOthers: false });
      if (ref.id === SEAT) {
        return destination({ kind: "kingdom_seat", id: SEAT, anchorPlayerId: "founder", ownerPlayerId: "founder", personalFlag: false });
      }
      if (ref.id === CITY_FLAG) {
        return destination({ id: CITY_FLAG, anchorPlayerId: "founder", ownerPlayerId: "owner", personalFlag: false });
      }
      return destination();
    }),
    loadPlayerStatus: vi.fn(async (playerId: string) => statuses.get(playerId) ?? null),
    revertOpenStructures: vi.fn(async () => ({ harvestAssets: 1 })),
    countOpenStructures: vi.fn(async () => ({ harvestAssets: 1 }))
  };
  const anchoring = {
    isDestinationAnchored: vi.fn(async () => anchored),
    invalidate: vi.fn()
  };
  const recordSignals = vi.fn(async (input: unknown) => { void input; });
  const gate = new DestinationAnchorGate(store, anchoring, { TRUST_ANCHOR_MODE: mode }, {
    sink: { recordSignals },
    now: () => NOW
  });
  return { gate, store, anchoring, recordSignals };
}

const travel = (travellerPlayerId: string, extra: Record<string, unknown> = {}) => ({
  travellerPlayerId,
  kind: "flag",
  destination: { kind: "flag", id: CITY_FLAG, personalFlagId: CITY_FLAG },
  ...extra
});
const personalTravel = (travellerPlayerId: string, extra: Record<string, unknown> = {}) => ({
  travellerPlayerId,
  kind: "flag",
  destination: { kind: "flag", id: FLAG, personalFlagId: FLAG },
  ...extra
});

describe("anchorDestinationRef", () => {
  it("maps flags, cities, Castle anchors and ignores the open world", () => {
    expect(anchorDestinationRef(personalTravel("x"))).toEqual({ kind: "flag", id: FLAG });
    expect(anchorDestinationRef({ travellerPlayerId: "x", kind: "city", destination: { kind: "city", id: CITY } }))
      .toEqual({ kind: "city", id: CITY });
    expect(anchorDestinationRef({
      travellerPlayerId: "x",
      kind: "invite",
      destination: { kind: "world", id: null, travelAnchor: { sourceType: "kingdom_seat", sourceId: SEAT } }
    })).toEqual({ kind: "flag", id: SEAT });
    expect(anchorDestinationRef({ travellerPlayerId: "x", kind: "invite", destination: { kind: "world", id: null } })).toBeNull();
    expect(anchorDestinationRef({ travellerPlayerId: "x", kind: "flag", destination: { kind: "flag", id: "not-a-uuid" } })).toBeNull();
  });
});

describe("DestinationAnchorGate travel", () => {
  it("always lets the owner reach their own destination", async () => {
    const { gate, anchoring } = harness("enforce");
    expect(await gate.checkTravel(travel("owner"))).toBeNull();
    expect(anchoring.isDestinationAnchored).not.toHaveBeenCalled();
  });

  it("refuses a stranger on an unanchored city flag, city and Castle in enforce", async () => {
    const { gate, recordSignals } = harness("enforce");
    expect(await gate.checkTravel(travel("stranger"))).toEqual({
      code: "DESTINATION_UNANCHORED",
      message: DESTINATION_UNANCHORED_MESSAGE
    });
    expect(await gate.checkTravel({ travellerPlayerId: "stranger", kind: "city", destination: { kind: "city", id: CITY } }))
      .not.toBeNull();
    expect(await gate.checkTravel({ travellerPlayerId: "stranger", kind: "flag", destination: { kind: "flag", id: SEAT } }))
      .not.toBeNull();
    const first = recordSignals.mock.calls[0]![0] as unknown as { accountId: string; signals: Array<{ rule: string; weight: number }> };
    expect(first.accountId).toBe("acc-stranger");
    expect(first.signals[0]).toMatchObject({ rule: "travel_unanchored_destination", weight: 0 });
    expect(DESTINATION_UNANCHORED_MESSAGE).not.toMatch(/\d/u);
  });

  it("allows a stranger when the destination is anchored", async () => {
    const { gate, recordSignals } = harness("enforce", true);
    expect(await gate.checkTravel(travel("stranger"))).toBeNull();
    expect(recordSignals).not.toHaveBeenCalled();
  });

  it("skips when the invite or party host owns the destination, but not a third party's", async () => {
    const { gate } = harness("enforce");
    expect(await gate.checkTravel(travel("stranger", { kind: "party_auto_follow", companionHostPlayerId: "owner" }))).toBeNull();
    expect(await gate.checkTravel(travel("stranger", { kind: "party_auto_follow", companionHostPlayerId: "settled" })))
      .not.toBeNull();
  });

  it("never anchors personal flags, even when the owner is not Settled (owner decision 2026-10-15)", async () => {
    for (const mode of ["shadow", "enforce"] as const) {
      const { gate, anchoring, recordSignals } = harness(mode);
      expect(await gate.checkTravel(personalTravel("stranger"))).toBeNull();
      expect(await gate.checkTravel(personalTravel("stranger", { kind: "party_auto_follow", companionHostPlayerId: "settled" })))
        .toBeNull();
      expect(await gate.checkTravel({
        travellerPlayerId: "stranger",
        kind: "invite",
        destination: { kind: "world", id: null, travelAnchor: { sourceType: "flag", sourceId: FLAG } },
        companionHostPlayerId: "settled"
      })).toBeNull();
      expect(anchoring.isDestinationAnchored).not.toHaveBeenCalled();
      expect(recordSignals).not.toHaveBeenCalled();
    }
  });

  it("ignores private personal flags, other travel kinds and off mode", async () => {
    const { gate } = harness("enforce");
    expect(await gate.checkTravel({ travellerPlayerId: "stranger", kind: "flag", destination: { kind: "flag", id: PRIVATE_FLAG } }))
      .toBeNull();
    expect(await gate.checkTravel(travel("stranger", { kind: "manor_jump" }))).toBeNull();
    const off = harness("off");
    expect(await off.gate.checkTravel(travel("stranger"))).toBeNull();
    expect(off.store.resolveDestination).not.toHaveBeenCalled();
  });

  it("only records the signal in shadow", async () => {
    const { gate, recordSignals } = harness("shadow");
    expect(await gate.checkTravel(travel("stranger"))).toBeNull();
    expect(recordSignals).toHaveBeenCalledTimes(1);
  });

  it("fails open when the destination cannot be read", async () => {
    const { gate, store } = harness("enforce");
    vi.mocked(store.resolveDestination).mockRejectedValueOnce(new Error("db down"));
    expect(await gate.checkTravel(travel("stranger"))).toBeNull();
  });
});

describe("DestinationAnchorGate private structures", () => {
  it("refuses opening structures until Settled in enforce", async () => {
    const { gate } = harness("enforce");
    expect(await gate.checkOpenStructure({ playerId: "stranger", kind: "harvest_access" })).toEqual({
      code: "PRIVATE_UNTIL_SETTLED",
      message: PRIVATE_UNTIL_SETTLED_MESSAGE
    });
    expect(await gate.checkOpenStructure({ playerId: "stranger", kind: "city_found" })).not.toBeNull();
    expect(await gate.checkOpenStructure({ playerId: "settled", kind: "city_found" })).toBeNull();
    expect(PRIVATE_UNTIL_SETTLED_MESSAGE).not.toMatch(/\d/u);
  });

  it("only signals in shadow", async () => {
    const { gate, recordSignals } = harness("shadow");
    expect(await gate.checkOpenStructure({ playerId: "stranger", kind: "harvest_access" })).toBeNull();
    expect(recordSignals).toHaveBeenCalled();
  });

  it("reverts public harvest access on revocation in enforce and only counts in shadow", async () => {
    const enforce = harness("enforce");
    await enforce.gate.onRevoked("acc-stranger");
    expect(enforce.store.revertOpenStructures).toHaveBeenCalledWith("acc-stranger");
    expect(enforce.anchoring.invalidate).toHaveBeenCalledWith("acc-stranger");
    const shadow = harness("shadow");
    await shadow.gate.onRevoked("acc-stranger");
    expect(shadow.store.revertOpenStructures).not.toHaveBeenCalled();
    expect(shadow.store.countOpenStructures).toHaveBeenCalledWith("acc-stranger");
  });
});
