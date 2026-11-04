// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  CITY_FACILITY_COSTS,
  CITY_MARKET_COST,
  CITY_MONUMENT_COSTS,
  EMPTY_CITY_DISTRICT_BENEFIT,
  type CityAppSnapshot,
  type CitySnapshot,
  type CityStructureSnapshot
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CityAppPanel } from "./CityAppPanel.js";

const city: CitySnapshot = {
  id: "00000000-0000-4000-8000-0000000000c1",
  worldId: "main",
  worldSettlementId: "settlement-1",
  worldSettlementSource: "global-boundaries",
  worldSourceSettlementId: "source-1",
  settlementClass: "city",
  settlementReleaseId: "world-settlements-v1",
  settlementReleaseFingerprint: "f".repeat(64),
  name: "Albuquerque",
  countryCode: "US",
  regionCode: "US-NM",
  founderPlayerId: "player-1",
  founderUsername: "Ash",
  mayorPlayerId: null,
  mayorUsername: "Vacant",
  mayorConfirmed: false,
  founderMayorClaimDeadline: null,
  seatFlagId: "00000000-0000-4000-8000-000000000001",
  lat: 35.0844,
  lon: -106.6504,
  active: true,
  jumpable: true,
  constructionPhase: "complete",
  constructionCompletedAt: "2026-07-10T00:00:00.000Z",
  constructionContributions: [],
  spatialRevision: "1",
  foundingAnnexRadiusM: 750,
  createdAt: "2026-07-10T00:00:00.000Z"
};

const house: CityStructureSnapshot = {
  structureId: "00000000-0000-4000-8000-000000000002",
  cityId: city.id,
  type: "city_house",
  tier: 1,
  districtType: null,
  ownerPlayerId: "player-2",
  worldId: "main",
  regionCode: "US-NM",
  lat: 35.085,
  lon: -106.65,
  footprintRadiusM: 10,
  placementRevision: "1",
  state: "active",
  constructionStartedAt: city.createdAt,
  constructionCompletesAt: city.createdAt,
  builtAt: city.createdAt,
  upgradedAt: null,
  destroyedAt: null
};

const snapshot: CityAppSnapshot = {
  city,
  membership: {
    cityId: city.id,
    cityName: city.name,
    role: "member",
    joinedAt: city.createdAt,
    expansionFlagCount: 0,
    expansionFlagLimit: 6,
    houseStructureId: house.structureId
  },
  municipality: city.name,
  region: "New Mexico",
  country: "United States",
  memberCount: 17,
  house,
  structures: [],
  treasuryBalance: "12500",
  lifetimeCoinsEarned: "25000",
  lifetimeCoinsSpent: "12500",
  playerContribution: "750",
  playerContributionRank: 2,
  leaderboard: [],
  ownLeaderboardEntry: null,
  warehouseUsedSlots: 0,
  warehouseTotalSlots: 0,
  facilityCosts: CITY_FACILITY_COSTS,
  civicCosts: { market: CITY_MARKET_COST, monument: CITY_MONUMENT_COSTS },
  district: {
    districtRevision: "0",
    monuments: {
      mining: { districtType: "mining", structureId: null, status: "inactive", tier: null },
      forestry: { districtType: "forestry", structureId: null, status: "inactive", tier: null },
      hunting: { districtType: "hunting", structureId: null, status: "inactive", tier: null }
    },
    memberBenefit: EMPTY_CITY_DISTRICT_BENEFIT,
    standardBuyerTaxBps: 900,
    specialtyBuyerTaxBps: 450,
    specialtyDescriptions: {}
  },
  gold: {
    balance: "0", capacity: "30000", remainingCapacity: "30000",
    lifetimeDonated: "0", lifetimeSpent: "0", revision: "0",
    canDonate: false, recentDonations: []
  },
  founderClaimDeadline: null,
  playerIsFounder: false,
  mayorVacant: true,
  mayorClaimAllowed: true,
  mayorClaimReason: null,
  activeConstruction: null
};

const callbacks = {
  onRefresh: vi.fn(),
  onDestroyHouse: vi.fn(),
  onClaimMayor: vi.fn(),
  onRelinquishMayor: vi.fn(),
  onBuildFacility: vi.fn(),
  onUpgradeFacility: vi.fn(),
  onDestroyFacility: vi.fn(),
  onOpenWarehouse: vi.fn(),
  onOpenMarket: vi.fn(),
  onDestroyMonument: vi.fn(),
  onClose: vi.fn()
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CityAppPanel states and overview", () => {
  it("shows a polite loading state", () => {
    renderPanel({ snapshot: null });
    expect(screen.getByRole("status").textContent).toContain("Loading city records");
  });

  it("shows the no-membership state and refresh action", () => {
    renderPanel({
      snapshot: { ...snapshot, city: null, membership: null, house: null }
    });
    expect(screen.getByRole("heading", { name: "No active city membership" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
  });

  it("shows founder and vacant Mayor separately before the founder builds a house", () => {
    renderPanel({
      snapshot: {
        ...snapshot,
        membership: null,
        house: null,
        founderClaimDeadline: new Date(Date.now() + 15 * 60_000).toISOString(),
        playerIsFounder: true,
        mayorClaimAllowed: false,
        mayorClaimReason: "Build an active City House before the founder reservation expires"
      }
    });
    expect(screen.getByText(/Founder: Ash · Mayor: Vacant/)).toBeTruthy();
    expect(screen.getByText(
      /You founded this city\. Use Build > City > City House, then claim Mayor within/
    )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Relinquish Mayor" })).toBeNull();
  });

  it("shows an authoritative 30-second pending House before membership activates", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    renderPanel({
      snapshot: {
        ...snapshot,
        membership: null,
        house: {
          ...house,
          state: "constructing",
          constructionStartedAt: now.toISOString(),
          constructionCompletesAt: new Date(now.getTime() + 30_000).toISOString(),
          builtAt: null
        }
      }
    });

    expect(screen.getAllByRole("heading", { name: "Albuquerque" })).toHaveLength(2);
    expect(screen.getByText(/City House constructing/).closest("p")?.textContent)
      .toContain("0:30");
    expect(screen.queryByRole("heading", { name: "No active city membership" })).toBeNull();
    vi.useRealTimers();
  });

  it("derives the pending House countdown from synchronized server time", () => {
    let serverNow = Date.parse("2026-07-30T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(serverNow + 2 * 60_000);
    renderPanel({
      synchronizedNow: () => serverNow,
      snapshot: {
        ...snapshot,
        membership: null,
        house: {
          ...house,
          state: "constructing",
          constructionStartedAt: new Date(serverNow).toISOString(),
          constructionCompletesAt: new Date(serverNow + 30_000).toISOString(),
          builtAt: null
        }
      }
    });

    expect(screen.getByText(/City House constructing/).closest("p")?.textContent)
      .toContain("0:30");
    serverNow += 5_000;
    void act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/City House constructing/).closest("p")?.textContent)
      .toContain("0:25");
    vi.useRealTimers();
  });

  it("prioritizes human-readable city, membership, house, and treasury information", () => {
    renderPanel();
    const overview = screen.getByRole("region", { name: "Overview" });
    expect(within(overview).getByText("Albuquerque")).toBeTruthy();
    expect(within(overview).getByText("Albuquerque, New Mexico, United States")).toBeTruthy();
    expect(within(overview).getByText("17")).toBeTruthy();
    expect(within(overview).getByText("City House · Active")).toBeTruthy();
    expect(screen.getAllByText("12,500")).toHaveLength(2);
    expect(screen.getByText("Map coordinates 35.08440, -106.65040")).toBeTruthy();
  });

  it("renders the phone shell safely with long place names", () => {
    const longName = "The Free City of an Exceptionally Long Municipality Name";
    const { container } = renderPanel({
      layout: "phone",
      snapshot: {
        ...snapshot,
        city: { ...city, name: longName },
        municipality: longName,
        region: "A Region Whose Ceremonial Name Is Also Unusually Long",
        country: "The United Provinces of the Far Western Reach"
      }
    });
    expect(screen.getByRole("dialog", { name: longName })).toBeTruthy();
    expect(container.querySelector(".phone-menu-layer.city-app-panel")).toBeTruthy();
    expect(screen.getAllByText(longName).length).toBeGreaterThan(0);
  });
});

describe("CityAppPanel management authority", () => {
  it("lets a house-backed member claim a vacant mayor office", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Become Mayor" }));
    expect(callbacks.onClaimMayor).toHaveBeenCalledWith(city.id);
    expect(screen.queryByRole("button", { name: "Relinquish Mayor" })).toBeNull();
  });

  it("disables a non-founder claim during the exclusive reservation", () => {
    renderPanel({
      snapshot: {
        ...snapshot,
        founderClaimDeadline: new Date(Date.now() + 14 * 60_000 + 32_000).toISOString(),
        mayorClaimAllowed: false,
        mayorClaimReason: "The founder still has the exclusive Mayor claim reservation"
      }
    });
    const claim = screen.getByRole("button", { name: "Become Mayor" }) as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
    expect(screen.getByText(/The founder has 14m 32s to claim Mayor/)).toBeTruthy();
    fireEvent.click(claim);
    expect(callbacks.onClaimMayor).not.toHaveBeenCalled();
  });

  it("refreshes authoritative City state when the displayed reservation expires", () => {
    renderPanel({
      snapshot: {
        ...snapshot,
        founderClaimDeadline: new Date(Date.now() - 1_000).toISOString(),
        mayorClaimAllowed: false,
        mayorClaimReason: "The founder still has the exclusive Mayor claim reservation"
      }
    });
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
  });

  it("confirms the mayor relinquish action without dispatching on cancel", () => {
    const warehouse = facility("warehouse", 2);
    renderPanel({
      layout: "phone",
      snapshot: mayorSnapshot({ structures: [warehouse] })
    });
    fireEvent.click(screen.getByRole("button", { name: "Relinquish Mayor" }));
    const prompt = screen.getByText("Relinquish Mayor?").closest("aside")!;
    expect(callbacks.onRelinquishMayor).not.toHaveBeenCalled();
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(callbacks.onRelinquishMayor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Relinquish Mayor" }));
    fireEvent.click(within(
      screen.getByText("Relinquish Mayor?").closest("aside")!
    ).getByRole("button", { name: "Relinquish Mayor" }));
    expect(callbacks.onRelinquishMayor).toHaveBeenCalledWith(city.id);
    expect(screen.queryByRole("button", { name: "Become Mayor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Destroy City House" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Destroy" })).toBeTruthy();
  });

  it("manages simultaneous Monuments with uniquely named destruction confirmations", () => {
    const miningMonument: CityStructureSnapshot = {
      ...house,
      structureId: "mining-monument-1",
      type: "monument",
      districtType: "mining",
      footprintRadiusM: 15
    };
    const forestryMonument: CityStructureSnapshot = {
      ...miningMonument,
      structureId: "forestry-monument-1",
      districtType: "forestry"
    };
    renderPanel({ snapshot: mayorSnapshot({
      structures: [miningMonument, forestryMonument],
      district: {
        ...snapshot.district,
        monuments: {
          ...snapshot.district.monuments,
          mining: { districtType: "mining", structureId: miningMonument.structureId, status: "active", tier: 1 },
          forestry: { districtType: "forestry", structureId: forestryMonument.structureId, status: "active", tier: 2 }
        }
      }
    }) });
    expect(screen.getByText("2 of 3 active")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Destroy Mining Monument" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Destroy Forestry Monument" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Destroy Mining Monument" }));
    fireEvent.click(within(
      screen.getByText("Destroy the Mining Monument?").closest("aside")!
    ).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Destroy Forestry Monument" }));
    const prompt = screen.getByText("Destroy the Forestry Monument?").closest("aside")!;
    expect(callbacks.onDestroyMonument).not.toHaveBeenCalled();
    fireEvent.click(within(prompt).getByRole("button", { name: "Destroy Forestry Monument" }));
    expect(callbacks.onDestroyMonument).toHaveBeenCalledOnce();
    expect(callbacks.onDestroyMonument).toHaveBeenCalledWith(forestryMonument);
  });

  it("disables every available action while busy", () => {
    renderPanel({
      busy: true,
      snapshot: mayorSnapshot({ structures: [facility("warehouse", 2)] })
    });
    const actions = screen.getAllByRole("button").filter((button) =>
      /Build Tier 1|Upgrade to Tier 3|Destroy|Relinquish Mayor/.test(button.textContent ?? "")
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("CityAppPanel facilities", () => {
  it("offers Open Warehouse without a Visit action", () => {
    renderPanel({ snapshot: mayorSnapshot({ structures: [facility("warehouse", 2)] }) });
    expect(screen.getByRole("button", { name: "Open Warehouse" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Visit" })).toBeNull();
  });

  it("directs the Mayor to Build Center when the Warehouse is missing", () => {
    renderPanel({
      snapshot: mayorSnapshot({ structures: [] })
    });

    expect(screen.getByText("0/3 active")).toBeTruthy();
    expect(screen.getByText("Warehouse")).toBeTruthy();
    expect(screen.getAllByText("Available to build")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Build Tier 1" })).toBeNull();
  });

  it("presents the built Warehouse with its next relevant cost", () => {
    const warehouse = facility("warehouse", 2);
    renderPanel({
      snapshot: mayorSnapshot({
        structures: [warehouse],
        warehouseUsedSlots: 34,
        warehouseTotalSlots: 100,
        warehouseCurrentWeightGrams: "85000",
        warehouseMaximumWeightGrams: "1000000"
      })
    });
    expect(screen.getByText("85 / 1,000 kg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade to Tier 3" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build Tier 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Warehouse" }));
    expect(callbacks.onOpenWarehouse).toHaveBeenCalledWith(warehouse);
    expect(screen.getAllByRole("img", { name: "Wood 430" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("img", { name: "Stone 12" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("img", { name: "City Coins 1,400" }).length).toBeGreaterThanOrEqual(2);
  });

  it("renders facility costs from the authoritative City snapshot", () => {
    renderPanel({
      snapshot: mayorSnapshot({
        structures: [facility("warehouse", 2)],
        facilityCosts: {
          ...CITY_FACILITY_COSTS,
          warehouse: {
            ...CITY_FACILITY_COSTS.warehouse,
            3: {
              materials: [
                { itemId: "wood", quantity: 401 },
                { itemId: "stone", quantity: 11 }
              ],
              cityCoins: 1_501
            }
          }
        }
      })
    });

    expect(screen.getAllByRole("img", { name: "Wood 401" })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "City Coins 1,501" })).toHaveLength(2);
    expect(screen.queryByRole("img", { name: "Wood 400" })).toBeNull();
  });

  it("contains missing facility costs and keeps an active Warehouse usable", () => {
    const warehouse = facility("warehouse", 1);
    renderPanel({
      snapshot: mayorSnapshot({
        structures: [warehouse],
        facilityCosts: undefined
      } as unknown as Partial<CityAppSnapshot>)
    });

    expect(screen.getAllByText("Warehouse costs are temporarily unavailable. Refresh City data.").length)
      .toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Upgrade to Tier 2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Warehouse" }));
    expect(callbacks.onOpenWarehouse).toHaveBeenCalledWith(warehouse);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(callbacks.onRefresh).toHaveBeenCalled();
  });

  it("removes the upgrade action at maximum tier but preserves destroy", () => {
    renderPanel({
      snapshot: mayorSnapshot({ structures: [facility("warehouse", 3)] })
    });
    expect(screen.getByText("Maximum tier reached")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to Tier 4/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
    expect(callbacks.onDestroyFacility).toHaveBeenCalledWith(expect.objectContaining({
      type: "warehouse",
      tier: 3
    }));
  });

  it("keeps military buildings and roster controls out of the City app", () => {
    const barracks = {
      ...house,
      structureId: "barracks-1",
      type: "barracks" as const,
      ownerPlayerId: "player-2"
    };
    const demolitionFactory = {
      ...house,
      structureId: "demolition-factory-1",
      type: "demolition_factory" as const,
      ownerPlayerId: "player-2"
    };
    renderPanel({
      snapshot: mayorSnapshot({
        structures: [barracks, demolitionFactory]
      })
    });

    expect(screen.queryByRole("tab", { name: "Buildings" })).toBeNull();
    expect(screen.queryByText("Personal Lodge")).toBeNull();
    expect(screen.queryByText("Barracks")).toBeNull();
    expect(screen.queryByText("Demolition Factory")).toBeNull();
    expect(screen.queryByText("Armory")).toBeNull();
    expect(screen.queryByText("Siege Workshop")).toBeNull();
    expect(screen.queryByText("Powder Works")).toBeNull();
    expect(screen.queryByText("War Camp")).toBeNull();
    expect(screen.queryByText("Military Industry")).toBeNull();
    expect(screen.queryByText("Requesting Lodge and military production records…")).toBeNull();
  });
});

describe("CityAppPanel contributors", () => {
  it("shows a suitable empty leaderboard state", () => {
    renderPanel();
    expect(screen.getByText("No City Coin contributions have been recorded yet.")).toBeTruthy();
  });

  it("renders ranked rows and highlights the local player without duplicate standing", () => {
    const ownEntry = {
      playerId: "player-2",
      username: "Bex of the Very Long Northern Watch",
      contributed: "750",
      rank: 2,
      currentMember: true
    };
    renderPanel({
      snapshot: {
        ...snapshot,
        leaderboard: [
          { playerId: "player-1", username: "Ash", contributed: "900", rank: 1, currentMember: false },
          ownEntry
        ],
        ownLeaderboardEntry: ownEntry
      }
    });
    const localRow = screen.getByText(ownEntry.username).closest("li");
    expect(localRow?.classList.contains("is-local-player")).toBe(true);
    expect(within(localRow!).getByText("You")).toBeTruthy();
    expect(screen.queryByText("Your standing")).toBeNull();
  });
});

function renderPanel({
  snapshot: nextSnapshot = snapshot,
  busy = false,
  layout = "desktop",
  synchronizedNow
}: {
  snapshot?: CityAppSnapshot | null;
  busy?: boolean;
  layout?: "desktop" | "phone";
  synchronizedNow?: () => number;
} = {}) {
  return render(
    <CityAppPanel
      open
      snapshot={nextSnapshot}
      playerPosition={{ lat: 35.085, lon: -106.65 }}
      busy={busy}
      layout={layout}
      {...(synchronizedNow ? { synchronizedNow } : {})}
      {...callbacks}
    />
  );
}

function mayorSnapshot(overrides: Partial<CityAppSnapshot> = {}): CityAppSnapshot {
  return {
    ...snapshot,
    city: {
      ...city,
      mayorPlayerId: "player-2",
      mayorUsername: "Bex",
      mayorConfirmed: true
    },
    membership: { ...snapshot.membership!, role: "mayor" },
    mayorVacant: false,
    mayorClaimAllowed: false,
    mayorClaimReason: "This city already has a Mayor",
    ...overrides
  };
}

function facility(
  type: "warehouse" | "weaponsmith" | "armory",
  tier: 1 | 2 | 3
): CityStructureSnapshot {
  return {
    ...house,
    structureId: `${type}-${tier}`,
    type,
    tier,
    footprintRadiusM: type === "warehouse" ? 18 : 15
  };
}
