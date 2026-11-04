import type {
  MarketBookSnapshot,
  MarketQuote,
  MarketSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";

export type MarketDevelopmentFixture = {
  name: "populated" | "empty" | "insufficient";
  snapshot: MarketSnapshot;
  book: MarketBookSnapshot;
  inventory: PlayerInventorySnapshot;
  quote: MarketQuote | null;
};

/**
 * Read-only visual evidence data. It is development-only, query-parameter gated,
 * and never writes market records or replaces server mutation validation.
 */
export function readMarketDevelopmentFixture(): MarketDevelopmentFixture | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const requested = new URLSearchParams(window.location.search).get("marketFixture");
  if (requested !== "populated" && requested !== "empty" && requested !== "insufficient") return null;
  return makeFixture(requested);
}

function makeFixture(name: MarketDevelopmentFixture["name"]): MarketDevelopmentFixture {
  const empty = name === "empty";
  const walletGold = name === "insufficient" ? "4" : "142";
  const wood = {
    itemId: "wood",
    itemIdentity: "wood:default",
    displayName: "Wood",
    iconKey: "wood",
    category: "resource",
    bestAsk: empty ? null : "5",
    bestBid: empty ? null : "4",
    availableSellQuantity: empty ? "0" : "71",
    availableBuyQuantity: empty ? "0" : "30",
    lastTradePrice: empty ? null : "5",
    bookVersion: "42"
  };
  const snapshot: MarketSnapshot = {
    venue: {
      venueId: "00000000-0000-4000-8000-000000000901",
      venueKey: "market-ui-visual-fixture",
      displayName: "Wayfarer's City Market",
      scopeType: "regional",
      cityId: "00000000-0000-4000-8000-000000000903",
      cityName: "Wayfarer's Rest",
      marketStructureId: "00000000-0000-4000-8000-000000000904",
      activeMonumentTypes: ["mining", "forestry", "hunting"],
      standardBuyerTaxBps: 900,
      specialtyBuyerTaxBps: 450,
      taxRevision: "7"
    },
    sessionId: "00000000-0000-4000-8000-000000000905",
    controls: {
      accessAllowed: true,
      readOnly: false,
      newOrdersEnabled: true,
      matchingEnabled: true,
      cancellationsEnabled: true,
      claimsEnabled: true,
      venueFrozen: false,
      playerFrozen: false,
      message: null
    },
    categories: ["resource"],
    items: [wood, {
      itemId: "stone", itemIdentity: "stone:default", displayName: "Stone", iconKey: "stone",
      category: "resource", bestAsk: "8", bestBid: "6", availableSellQuantity: "44",
      availableBuyQuantity: "21", lastTradePrice: "7", bookVersion: "19"
    }],
    equipmentListings: [],
    nextCursor: null,
    player: {
      walletGold,
      walletVersion: "0",
      activeOrders: empty ? [] : [{
        orderId: "00000000-0000-4000-8000-000000000902",
        itemId: "wood",
        itemIdentity: "wood:default",
        displayName: "Wood",
        side: "buy",
        policy: "gtc",
        unitPrice: "3",
        originalQuantity: "12",
        filledQuantity: "4",
        remainingQuantity: "8",
        status: "partially_filled",
        prioritySequence: "901",
        createdAt: "2026-07-12T09:25:00.000Z",
        cancelledAt: null,
        completedAt: null
      }],
      recentOrders: [],
      recentFills: [],
      collection: { items: [], equipment: [], gold: "0" }
    },
    feePolicy: { version: 1, listingFee: "1", buyerFeeBps: 100, sellerFeeBps: 250, cancellationFee: "0" }
  };
  const book: MarketBookSnapshot = {
    item: wood,
    asks: empty ? [] : [
      { unitPrice: "5", quantity: "12", orderCount: 3 },
      { unitPrice: "6", quantity: "40", orderCount: 2 },
      { unitPrice: "7", quantity: "19", orderCount: 1 },
      { unitPrice: "9", quantity: "35", orderCount: 4 },
      { unitPrice: "12", quantity: "8", orderCount: 2 }
    ],
    bids: empty ? [] : [
      { unitPrice: "4", quantity: "10", orderCount: 2 },
      { unitPrice: "3", quantity: "20", orderCount: 2 },
      { unitPrice: "2", quantity: "44", orderCount: 5 },
      { unitPrice: "1", quantity: "80", orderCount: 7 }
    ],
    recentTrades: empty ? [] : [
      fixtureTrade("00000000-0000-4000-8000-000000000911", "5", "5", "25", "2026-07-12T10:10:00.000Z"),
      fixtureTrade("00000000-0000-4000-8000-000000000912", "2", "6", "12", "2026-07-12T10:03:00.000Z"),
      fixtureTrade("00000000-0000-4000-8000-000000000913", "8", "5", "40", "2026-07-12T09:52:00.000Z")
    ]
  };
  const inventory: PlayerInventorySnapshot = {
    playerId: "visual-fixture-player",
    revision: 0,
    items: [
      { playerId: "visual-fixture-player", resourceType: "wood", variant: null, quantity: 18 },
      { playerId: "visual-fixture-player", resourceType: "stone", variant: null, quantity: 4 },
      { playerId: "visual-fixture-player", resourceType: "leather", variant: null, quantity: 2 },
      { playerId: "visual-fixture-player", resourceType: "balsam_resin", variant: null, quantity: 1 }
    ],
    totals: { wood: 18, stone: 4, coal: 0, iron: 0, sulfur: 0, iron_bar: 0, venomsteel_bar: 0, venomsteel_core: 0, fire_feather: 0, tempest_quill: 0, ice_feather: 0, fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0, food: 0, ore: 0, water: 0, leather: 2, deer_hide: 0, hog_hide: 0, wolf_pelt: 0, bear_hide: 0, alligator_hide: 0, squid_flesh: 0, crab_carapace: 0, raw_meat: 0, shell: 0, giving_berry: 0, balsam_resin: 1, crude_oil: 0, jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0, crystal: 0, pearl: 0, atlas_shrine_shard: 0, enchantment_stone: 0 }
  };
  return {
    name,
    snapshot,
    book,
    inventory,
    quote: empty ? null : {
      quoteId: "00000000-0000-4000-8000-000000000920",
      itemId: "wood",
      itemIdentity: "wood:default",
      requestedQuantity: "1",
      requestedMaximumUnitPrice: "5",
      fillableQuantity: "1",
      quotedTotal: "6",
      grossItemTotal: "5",
      buyerTax: "1",
      buyerTotal: "6",
      appliedBuyerTaxBps: 900,
      taxLabel: "Hunting District standard tax",
      districtType: "hunting",
      taxRevision: "7",
      specialtyTaxApplied: false,
      qualifyingTaxTag: null,
      maximumUnitPrice: "5",
      fullQuantityAvailable: true,
      availability: "available",
      bookVersion: "42",
      expiresAt: "2099-12-31T23:59:59.000Z"
    }
  };
}

function fixtureTrade(
  tradeId: string,
  quantity: string,
  unitPrice: string,
  total: string,
  createdAt: string
) {
  return {
    tradeId,
    quantity,
    unitPrice,
    total,
    buyerTax: "0",
    sellerProceeds: total,
    buyerTaxBps: 900,
    specialtyTaxApplied: false,
    qualifyingTaxTag: null,
    createdAt
  };
}
