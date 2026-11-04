// @vitest-environment jsdom

import type {
  EquipmentSnapshotV2,
  MarketBookSnapshot,
  MarketEquipmentListingSnapshot,
  MarketSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MarketController,
  type MarketClientTransport
} from "../market/marketController.js";
import { MarketOverlay } from "./MarketOverlay.js";

const MARKET_STRUCTURE_ID = "00000000-0000-4000-8000-000000000001";
const MARKET_SESSION_ID = "00000000-0000-4000-8000-000000000002";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MarketOverlay", () => {
  it("renders the three primary sections and grouped order views", () => {
    renderMarket();

    expect(screen.getByRole("tablist", { name: "Market section" }).classList.contains("game-app-tabs-housed")).toBe(true);
    const categoryRail = screen.getByRole("tablist", { name: "Market categories" });
    expect(categoryRail.classList.contains("game-app-tabs-subtabs")).toBe(true);
    expect(categoryRail.classList.contains("game-app-tabs-subtabs-scrollable")).toBe(false);
    expect(categoryRail.classList.contains("game-app-tabs-housed")).toBe(false);
    expect(Array.from(categoryRail.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toEqual([
      "All", "Consumables", "Resources", "Equipment"
    ]);
    for (const name of ["Browse", "Sell", "Orders"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getByRole("tab", { name: "Browse" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    expect(screen.getByRole("tablist", { name: "Sell category" }).classList.contains("game-app-tabs-subtabs")).toBe(true);
    expect(screen.getByRole("tablist", { name: "Sell category" }).classList.contains("game-app-tabs-housed")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Orders" }));
    expect(screen.getByRole("tablist", { name: "Order view" }).classList.contains("game-app-tabs-subtabs")).toBe(true);
    expect(screen.getByRole("tab", { name: "Orders" }).getAttribute("aria-selected")).toBe("true");
    for (const name of ["Active", "Collect", "History"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getByRole("tab", { name: "Active" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Expired" })).toBeNull();
  });

  it("uses the application wallet authority instead of the market snapshot balance", () => {
    renderMarket({ walletGold: "275" });
    expect(screen.getByLabelText("Market buyer tax 9%").textContent).toContain("Tax9%");
    expect(document.querySelector(".market-venue-summary")).toBeNull();
    expect(screen.getByLabelText("Wallet balance 275 gold")).toBeTruthy();
    expect(screen.getByText("275 gold")).toBeTruthy();
    expect(screen.queryByText("100 gold")).toBeNull();
  });

  it("announces every active Monument specialty", () => {
    renderMarket({ activeMonumentTypes: ["mining", "forestry", "hunting"] });
    expect(screen.getByLabelText(
      "Market buyer tax 9%. Specialty buyer tax 4.5% Mining specialty, Forestry specialty, Hunting specialty"
    )).toBeTruthy();
  });

  it("keeps the controller active while a phone panel is closed", () => {
    const harness = renderMarket({ keepActive: true });
    harness.rerender(false);
    expect(harness.controller.getState().active).toBe(true);
    expect(harness.controller.getState().snapshot?.sessionId).toBe(MARKET_SESSION_ID);
  });

  it("refreshes through the current session without reopening it", () => {
    const harness = renderMarket();
    harness.marketOpen.mockClear();
    harness.marketBrowse.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Refresh Market" }));

    expect(screen.queryByText(/Refreshing Listings\. Mutations remain disabled/)).toBeNull();
    expect(harness.marketOpen).not.toHaveBeenCalled();
    expect(harness.marketBrowse).toHaveBeenCalledWith(
      expect.any(String),
      MARKET_SESSION_ID,
      { limit: 24, listedOnly: true }
    );
  });

  it("acknowledges refresh immediately and clears the visual state", () => {
    vi.useFakeTimers();
    renderMarket();
    const refresh = screen.getByRole("button", { name: "Refresh Market" });

    fireEvent.click(refresh);
    expect(refresh.classList.contains("acknowledged")).toBe(true);
    act(() => { vi.advanceTimersByTime(600); });
    expect(refresh.classList.contains("acknowledged")).toBe(false);
  });

  it("labels reconnecting state without showing stale data as ready", () => {
    const harness = renderMarket();
    act(() => harness.controller.onDisconnected());

    expect(screen.getByLabelText("Market connection Offline")).toBeTruthy();
    expect(screen.queryByLabelText("Market connection Ready")).toBeNull();
  });

  it("keeps global readiness stable while the selected listing loads", () => {
    renderMarket({ completeInitialBook: false });

    expect(screen.getByLabelText("Market connection Ready")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading offers" })).toBeTruthy();
    expect(screen.queryByText(/Mutations remain disabled/)).toBeNull();
  });

  it("keeps global readiness stable while a price quote loads", () => {
    vi.useFakeTimers();
    const harness = renderMarket();
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(harness.marketRequestQuote).toHaveBeenCalledOnce();
    expect(harness.controller.getState().quoteLoading).toBe(true);
    expect(screen.getByLabelText("Market connection Ready")).toBeTruthy();
    expect(screen.queryByText(/Mutations remain disabled/)).toBeNull();
  });

  it("does not describe a pending mutation as a book refresh", () => {
    vi.useFakeTimers();
    const harness = renderMarket();
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(harness.controller.getState().quoteLoading).toBe(true);
    act(() => void harness.controller.submitCreateOrder("merchant", "buy", "wood", "1", "7"));

    expect(screen.getByLabelText("Market connection Loading")).toBeTruthy();
    expect(screen.getAllByText("Order in progress…")).toHaveLength(1);
    expect(screen.queryByText(/Updating current offers/)).toBeNull();
    expect(screen.queryByText("Checking latest price…")).toBeNull();
    expect(screen.queryByText("Checking price…")).toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(document.querySelector(".market-quote-spinner")).toBeNull();
    expect(document.querySelector(".market-spinner")).toBeNull();
    expect(document.querySelector(".market-ledger-progress")).toBeTruthy();
  });

  it("shows quote rate limiting as an automatic local retry pause", () => {
    vi.useFakeTimers();
    const harness = renderMarket();
    act(() => {
      vi.advanceTimersByTime(180);
    });
    const requestId = harness.marketRequestQuote.mock.calls.at(-1)![0];
    act(() => void harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId,
      code: "MARKET_RATE_LIMITED",
      message: "Market request rate limit reached",
      retryable: true
    }));

    expect(screen.getByLabelText("Market connection Ready")).toBeTruthy();
    const buyButton = screen.getByRole("button", { name: "Price updates paused" });
    expect((buyButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Checking latest price…")).toBeNull();
    expect(document.querySelector(".market-quote-spinner")).toBeNull();
    expect(screen.queryByText("Access required")).toBeNull();
    expect(screen.queryByText("Request failed")).toBeNull();
  });

  it("shows rate limiting as a local listing update pause instead of lost access", () => {
    vi.useFakeTimers();
    const harness = renderMarket();
    act(() => {
      harness.controller.handleMessage({
        type: "MARKET_BOOK_CHANGED",
        itemId: "wood",
        bookVersion: "2"
      });
      vi.advanceTimersByTime(1_000);
    });
    const requestId = harness.marketGetBook.mock.calls.at(-1)![0];
    act(() => void harness.controller.handleMessage({
      type: "MARKET_ERROR",
      requestId,
      code: "MARKET_RATE_LIMITED",
      message: "Market request rate limit reached",
      retryable: true
    }));

    expect(screen.getByLabelText("Market connection Ready")).toBeTruthy();
    expect(screen.getByText("Live offer updates are paused. Retrying shortly.")).toBeTruthy();
    expect(screen.queryByText("Access required")).toBeNull();
    expect(screen.queryByText("Request failed")).toBeNull();
  });

  it("describes every asset available for collection", () => {
    renderMarket();
    fireEvent.click(screen.getByRole("tab", { name: "Orders" }));
    fireEvent.click(screen.getByRole("tab", { name: "Collect" }));

  });

  it("offers market-tradable rings even when they cannot be dropped on the ground", () => {
    renderMarket({ equipment: ringEquipment() });

    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));

    expect(screen.getByText("Chopping Ring")).toBeTruthy();
  });

  it("keeps desktop browse controls available while Equipment is selected", () => {
    renderMarket({ equipmentListings: [equipmentListing()] });

    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    expect(screen.getByRole("tab", { name: "Equipment" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Traveler Blade Level 4/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(screen.getByRole("button", { name: /Wood Owned 10/ })).toBeTruthy();
  });

  it("keeps another player's exact equipment listing in Browse", () => {
    renderMarket({ equipmentListings: [equipmentListing("player-2")] });

    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    expect(screen.getByRole("button", { name: /Traveler Blade Level 4/ })).toBeTruthy();
  });

  it("opens and backs out of exact equipment browse detail on phone", () => {
    renderMarket({ layout: "phone", equipmentListings: [equipmentListing()] });

    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    expect(screen.getByRole("tab", { name: "Equipment" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: /Wood Owned 10/ })).toBeNull();
    const listingRow = screen.getByRole("button", { name: /Traveler Blade Level 4/ });
    fireEvent.click(listingRow);
    expect(screen.getByRole("region", { name: "Traveler Blade equipment listing" })).toBeTruthy();
    expect(screen.getByText("Buyer total")).toBeTruthy();
    expect(screen.getByText("54 gold")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to items" }));
    expect(screen.getByRole("button", { name: /Traveler Blade Level 4/ })).toBeTruthy();
  });

  it("preserves exact purchase arguments and moves own-listing cancellation to Active Orders", () => {
    const purchase = renderMarket({ equipment: ringEquipment(), equipmentListings: [equipmentListing()] });
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    fireEvent.click(screen.getByRole("button", { name: /Traveler Blade Level 4/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Buy · / }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
    expect(purchase.marketPurchaseEquipmentListing).toHaveBeenCalledWith(
      expect.any(String), MARKET_SESSION_ID, equipmentListing().listingId, "3", "54", "1", "gold"
    );

    cleanup();
    const cancellation = renderMarket({ equipmentListings: [equipmentListing("player-1")] });
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    expect(screen.queryByRole("button", { name: /Traveler Blade Level 4/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Orders" }));
    fireEvent.click(screen.getByRole("button", { name: /Traveler Blade Level 4/ }));
    expect(screen.getByRole("region", { name: "Review cancellation of Traveler Blade" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Traveler Blade Level 4/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(cancellation.marketCancelEquipmentListing).toHaveBeenCalledWith(
      expect.any(String), MARKET_SESSION_ID, equipmentListing().listingId, "3"
    );
  });

  it("opens phone Browse directly on its persistent list and returns from detail", () => {
    const harness = renderMarket({ layout: "phone" });

    expect(screen.queryByText("Browse goods")).toBeNull();
    expect(screen.getByRole("tab", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Game" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Wood Owned 10/ }));
    expect(screen.getByRole("button", { name: "Back to items" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Wood listings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to items" }));
    expect(screen.getByRole("button", { name: /Wood Owned 10/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Game" }));
    expect(harness.onClose).toHaveBeenCalledOnce();
  });

  it("steps through sell category, owned rows, and the selected form on phone", () => {
    renderMarket({ layout: "phone" });

    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    expect(screen.getByRole("tab", { name: "Resources" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Resources" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Back to Game" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Wood Owned 10/ }));
    expect(screen.getByRole("button", { name: "Back to items" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sell Wood" })).toBeTruthy();
  });

  it("opens and backs out of an exact owned equipment listing form on phone", () => {
    renderMarket({ layout: "phone", equipment: ringEquipment() });

    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    fireEvent.click(screen.getByRole("button", { name: /Chopping Ring Level 0/ }));
    expect(screen.getByRole("region", { name: "List Chopping Ring" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to items" }));
    expect(screen.getByRole("button", { name: /Chopping Ring Level 0/ })).toBeTruthy();
  });

  it("preserves exact instance and inventory revision when listing equipment", () => {
    const harness = renderMarket({ equipment: ringEquipment() });
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    const browseRequestId = harness.marketBrowse.mock.calls.at(-1)?.[0];
    if (browseRequestId) act(() => void harness.controller.handleMessage({
      type: "MARKET_BROWSE_RESULT",
      requestId: browseRequestId,
      snapshot: snapshot()
    }));
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    fireEvent.click(screen.getByRole("button", { name: /Chopping Ring Level 0/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Asking price" }), { target: { value: "73" } });
    fireEvent.click(screen.getByRole("button", { name: "List item" }));
    fireEvent.click(screen.getByRole("button", { name: /^Confirm · / }));
    expect(harness.marketCreateEquipmentListing).toHaveBeenCalledWith(
      expect.any(String), MARKET_SESSION_ID, ringEquipment().instances[0]!.instanceId, "73", "1"
    );
  });

  it("lists equipment on phone through the in-game number pad", () => {
    const harness = renderMarket({ layout: "phone", equipment: ringEquipment() });
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    const browseRequestId = harness.marketBrowse.mock.calls.at(-1)?.[0];
    if (browseRequestId) act(() => void harness.controller.handleMessage({
      type: "MARKET_BROWSE_RESULT",
      requestId: browseRequestId,
      snapshot: snapshot()
    }));
    fireEvent.click(screen.getByRole("tab", { name: "Equipment" }));
    fireEvent.click(screen.getByRole("button", { name: /Chopping Ring Level 0/ }));
    const price = screen.getByRole("textbox", { name: "Asking price" }) as HTMLInputElement;
    expect(price.readOnly).toBe(true);
    fireEvent.click(price);
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "List item" }));
    fireEvent.click(screen.getByRole("button", { name: /^Confirm · / }));
    expect(harness.marketCreateEquipmentListing).toHaveBeenCalledWith(
      expect.any(String), MARKET_SESSION_ID, ringEquipment().instances[0]!.instanceId, "73", "1"
    );
  });
});

function renderMarket(options: {
  walletGold?: string | null;
  keepActive?: boolean;
  equipment?: EquipmentSnapshotV2;
  equipmentListings?: MarketEquipmentListingSnapshot[];
  completeInitialBook?: boolean;
  layout?: "desktop" | "phone";
  activeMonumentTypes?: MarketSnapshot["venue"]["activeMonumentTypes"];
} = {}) {
  let sequence = 0;
  const marketOpen = vi.fn<MarketClientTransport["marketOpen"]>(() => true);
  const marketBrowse = vi.fn<NonNullable<MarketClientTransport["marketBrowse"]>>(
    () => true
  );
  const marketGetBook = vi.fn<MarketClientTransport["marketGetBook"]>(() => true);
  const marketRequestQuote = vi.fn<MarketClientTransport["marketRequestQuote"]>(
    () => true
  );
  const marketCreateOrder = vi.fn<MarketClientTransport["marketCreateOrder"]>(
    () => true
  );
  const marketSimpleBuy = vi.fn<MarketClientTransport["marketSimpleBuy"]>(
    () => true
  );
  const marketCancelOrder = vi.fn<MarketClientTransport["marketCancelOrder"]>(
    () => true
  );
  const marketClaim = vi.fn<MarketClientTransport["marketClaim"]>(() => true);
  const marketSetSubscriptions = vi.fn<
    MarketClientTransport["marketSetSubscriptions"]
  >(() => true);
  const marketCreateEquipmentListing = vi.fn<NonNullable<MarketClientTransport["marketCreateEquipmentListing"]>>(() => true);
  const marketPurchaseEquipmentListing = vi.fn<NonNullable<MarketClientTransport["marketPurchaseEquipmentListing"]>>(() => true);
  const marketCancelEquipmentListing = vi.fn<NonNullable<MarketClientTransport["marketCancelEquipmentListing"]>>(() => true);
  const controller = new MarketController(
    () => ({
      marketOpen,
      marketBrowse,
      marketGetBook,
      marketRequestQuote,
      marketCreateOrder,
      marketSimpleBuy,
      marketCancelOrder,
      marketClaim,
      marketCreateEquipmentListing,
      marketPurchaseEquipmentListing,
      marketCancelEquipmentListing,
      marketSetSubscriptions
    }),
    {
      createRequestId: () => `ui-request-${++sequence}`,
      debounceMs: 1
    }
  );
  controller.setVenue(MARKET_STRUCTURE_ID, "1");
  const onClose = vi.fn();
  const overlay = (open: boolean) => (
    <MarketOverlay
      open={open}
      controller={controller}
      layout={options.layout ?? "desktop"}
      keepActive={options.keepActive ?? false}
      connectionStatus="online"
      inventory={inventory()}
      equipment={options.equipment ?? null}
      hasInventorySnapshot
      walletGold={options.walletGold === undefined ? "100" : options.walletGold}
      onClose={onClose}
    />
  );
  const rendered = render(overlay(true));
  act(() => controller.onReady());
  act(() => void controller.handleMessage({
    type: "MARKET_OPEN_RESULT",
    requestId: marketOpen.mock.calls.at(-1)![0],
    snapshot: {
      ...snapshot(),
      venue: {
        ...snapshot().venue,
        activeMonumentTypes: options.activeMonumentTypes ?? []
      },
      equipmentListings: options.equipmentListings ?? []
    }
  }));
  if (options.completeInitialBook !== false) {
    act(() => void controller.handleMessage({
      type: "MARKET_BOOK_RESULT",
      requestId: marketGetBook.mock.calls.at(-1)![0],
      book: book()
    }));
  }
  return {
    controller,
    marketOpen,
    marketBrowse,
    marketGetBook,
    marketRequestQuote,
    marketCreateOrder,
    marketCreateEquipmentListing,
    marketPurchaseEquipmentListing,
    marketCancelEquipmentListing,
    onClose,
    rerender: (open: boolean) => rendered.rerender(overlay(open))
  };
}

function ringEquipment(): EquipmentSnapshotV2 {
  return {
    playerId: "player-1",
    inventoryRevision: 1,
    instances: [{
      instanceId: "00000000-0000-4000-8000-000000000004",
      definitionId: "chopping_ring",
      displayName: "Chopping Ring",
      ownerPlayerId: "player-1",
      location: "inventory",
      equippedSlot: null,
      droppable: false,
      itemLevel: 0,
      category: "ring",
      savedKitIndices: [],
      derived: {},
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z"
    }]
  } as unknown as EquipmentSnapshotV2;
}

function equipmentListing(sellerPlayerId = "player-2"): MarketEquipmentListingSnapshot {
  return {
    listingId: "00000000-0000-4000-8000-000000000005",
    venueId: MARKET_STRUCTURE_ID,
    equipmentInstanceId: "00000000-0000-4000-8000-000000000006",
    definitionId: "starter_sword",
    displayName: "Traveler Blade",
    artworkKey: "starter_sword",
    category: "weapon",
    slot: "main_hand",
    itemLevel: 4,
    maximumItemLevel: 10,
    balanceVersion: 1,
    derivedStats: { attack: 7 },
    utilityIdentity: null,
    enchantmentIdentity: null,
    cosmeticIdentity: null,
    sellerPlayerId,
    askingPrice: "50",
    buyerTax: "4",
    buyerTotal: "54",
    buyerTaxBps: 900,
    status: "open",
    version: "3",
    createdAt: "2026-08-14T00:00:00.000Z"
  };
}

function inventory(): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 1,
    items: [{
      playerId: "player-1",
      resourceType: "wood",
      variant: null,
      quantity: 10
    }],
    totals: {
      wood: 10,
      stone: 0,
      coal: 0,
      iron: 0,
      sulfur: 0,
      iron_bar: 0,
      venomsteel_bar: 0,
      venomsteel_core: 0,
      fire_feather: 0, tempest_quill: 0, ice_feather: 0,
      fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      deer_hide: 0,
      hog_hide: 0,
      wolf_pelt: 0,
      bear_hide: 0,
      alligator_hide: 0,
      squid_flesh: 0,
      crab_carapace: 0,
      raw_meat: 0,
      shell: 0,
      giving_berry: 0,
      balsam_resin: 0,
      crude_oil: 0,
      jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
    }
  };
}

function snapshot(): MarketSnapshot {
  return {
    venue: {
      venueId: MARKET_STRUCTURE_ID,
      venueKey: "city-market",
      displayName: "Briar Market",
      scopeType: "regional",
      cityId: "00000000-0000-4000-8000-000000000003",
      cityName: "Briar",
      marketStructureId: MARKET_STRUCTURE_ID,
      activeMonumentTypes: [],
      standardBuyerTaxBps: 900,
      specialtyBuyerTaxBps: 450,
      taxRevision: "1"
    },
    sessionId: MARKET_SESSION_ID,
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
    items: [{
      itemId: "wood",
      itemIdentity: "wood",
      displayName: "Wood",
      iconKey: "wood",
      category: "resource",
      bestAsk: "8",
      bestBid: "7",
      availableSellQuantity: "25",
      availableBuyQuantity: "19",
      lastTradePrice: "8",
      bookVersion: "1"
    }],
    equipmentListings: [],
    nextCursor: null,
    player: {
      walletGold: "100",
      walletVersion: "1",
      activeOrders: [],
      recentOrders: [],
      recentFills: [],
      collection: { items: [], equipment: [], gold: "0" }
    },
    feePolicy: {
      version: 2,
      listingFee: "0",
      buyerFeeBps: 1_000,
      sellerFeeBps: 0,
      cancellationFee: "0"
    }
  };
}

function book(): MarketBookSnapshot {
  return {
    item: snapshot().items[0]!,
    asks: [{ unitPrice: "8", quantity: "10", orderCount: 2 }],
    bids: [{ unitPrice: "7", quantity: "4", orderCount: 1 }],
    recentTrades: []
  };
}
