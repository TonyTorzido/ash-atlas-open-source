import {
  CITY_FACILITY_COSTS,
  CITY_MARKET_COST,
  CITY_MONUMENT_COSTS,
  EMPTY_CITY_DISTRICT_BENEFIT,
  type CityAppSnapshot,
  type CityStructureSnapshot
} from "@ash-atlas/shared";

import { CityAppPanel } from "../src/ui/CityAppPanel.js";

const builtAt = "2026-07-10T00:00:00.000Z";
const cityId = "00000000-0000-4000-8000-0000000000c1";

export function CityAppPanelStory({
  layout
}: {
  layout: "desktop" | "phone";
}): React.JSX.Element {
  return (
    <div style={{ width: "100vw", height: "100vh", container: "mobile-app / size" }}>
      <CityAppPanel
        open
        snapshot={snapshot}
        playerPosition={{ lat: 35.085, lon: -106.65 }}
        busy={false}
        layout={layout}
        onRefresh={() => undefined}
        onDestroyHouse={() => undefined}
        onClaimMayor={() => undefined}
        onRelinquishMayor={() => undefined}
        onDestroyFacility={() => undefined}
      onOpenWarehouse={() => undefined}
      onOpenMarket={() => undefined}
        onClose={() => undefined}
      />
    </div>
  );
}

const house: CityStructureSnapshot = structure("city_house", 1, "house");

const snapshot: CityAppSnapshot = {
  city: {
    id: cityId,
    worldId: "main",
    worldSettlementId: "settlement-1",
    worldSettlementSource: "global-boundaries",
    worldSourceSettlementId: "source-1",
    settlementClass: "city",
    settlementReleaseId: "world-settlements-v1",
    settlementReleaseFingerprint: "f".repeat(64),
    name: "The Free City of the High Desert Covenant",
    countryCode: "US",
    regionCode: "US-NM",
    founderPlayerId: "player-1",
    founderUsername: "Ash of the First Western Expedition",
    mayorPlayerId: "player-2",
    mayorUsername: "Bex of the Very Long Northern Watch",
    mayorConfirmed: true,
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
    createdAt: builtAt
  },
  membership: {
    cityId,
    cityName: "The Free City of the High Desert Covenant",
    role: "mayor",
    joinedAt: builtAt,
    expansionFlagCount: 3,
    expansionFlagLimit: 6,
    houseStructureId: house.structureId
  },
  municipality: "A Municipality With an Exceptionally Ceremonial Name",
  region: "The Greater High Desert Administrative Region",
  country: "United Provinces of the Western Reach",
  memberCount: 148,
  house,
  structures: [
    structure("warehouse", 2, "warehouse"),
    structure("monument", 2, "mining-monument")
  ],
  treasuryBalance: "1284075",
  lifetimeCoinsEarned: "2450900",
  lifetimeCoinsSpent: "1166825",
  playerContribution: "128500",
  playerContributionRank: 2,
  leaderboard: [
    { rank: 1, playerId: "player-1", username: "Ash of the First Western Expedition", contributed: "250000", currentMember: false },
    { rank: 2, playerId: "player-2", username: "Bex of the Very Long Northern Watch", contributed: "128500", currentMember: true },
    { rank: 3, playerId: "player-3", username: "Mara Stonewright", contributed: "92250", currentMember: true }
  ],
  ownLeaderboardEntry: {
    rank: 2,
    playerId: "player-2",
    username: "Bex of the Very Long Northern Watch",
    contributed: "128500",
    currentMember: true
  },
  warehouseUsedSlots: 87,
  warehouseTotalSlots: 100,
  facilityCosts: CITY_FACILITY_COSTS,
  civicCosts: { market: CITY_MARKET_COST, monument: CITY_MONUMENT_COSTS },
  district: {
    districtRevision: "3",
    monuments: {
      mining: { districtType: "mining", structureId: "mining-monument", status: "active", tier: 2 },
      forestry: { districtType: "forestry", structureId: null, status: "inactive", tier: null },
      hunting: { districtType: "hunting", structureId: null, status: "inactive", tier: null }
    },
    memberBenefit: {
      ...EMPTY_CITY_DISTRICT_BENEFIT,
      cityId,
      monumentTiers: { mining: 2, forestry: null, hunting: null },
      districtRevision: "3",
      miningExtraYieldChance: 0.02
    },
    standardBuyerTaxBps: 900,
    specialtyBuyerTaxBps: 450,
    specialtyDescriptions: { mining: "stone, ore, bars, and mining tools" }
  },
  gold: {
    balance: "22500", capacity: "30000", remainingCapacity: "7500",
    lifetimeDonated: "35000", lifetimeSpent: "12500", revision: "4",
    canDonate: true,
    recentDonations: [{ playerId: "player-2", username: "Bex", amount: "5000", donatedAt: builtAt }]
  },
  founderClaimDeadline: null,
  playerIsFounder: false,
  mayorVacant: false,
  mayorClaimAllowed: false,
  mayorClaimReason: "This city already has a Mayor",
  activeConstruction: null
};

function structure(
  type: CityStructureSnapshot["type"],
  tier: 1 | 2 | 3,
  id: string
): CityStructureSnapshot {
  return {
    structureId: id,
    cityId,
    type,
    tier,
    districtType: type === "monument" ? "mining" : null,
    ownerPlayerId: type === "city_house" ? "player-2" : null,
    worldId: "main",
    regionCode: "US-NM",
    lat: 35.085,
    lon: -106.65,
    footprintRadiusM: type === "warehouse" ? 18 : 15,
    placementRevision: "1",
    state: "active",
    constructionStartedAt: builtAt,
    constructionCompletesAt: builtAt,
    builtAt,
    upgradedAt: null,
    destroyedAt: null
  };
}
