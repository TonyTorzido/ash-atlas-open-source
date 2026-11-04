// @vitest-environment jsdom

import type { MarketItemSummary, MarketOrderSnapshot, PlayerInventorySnapshot } from "@ash-atlas/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { itemArtworkSource } from "../ItemArtwork.js";
import { MarketCatalog } from "./MarketCatalog.js";

describe("MarketCatalog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses shared inventory artwork for every market resource without inline placeholder SVGs", () => {
    const itemIds = ["wood", "stone", "leather", "balsam_resin", "atlas_shrine_shard"] as const;
    const items = itemIds.map((itemId, index): MarketItemSummary => ({
      itemId,
      itemIdentity: itemId,
      displayName: itemId === "balsam_resin" ? "Balsam Resin" : itemId === "atlas_shrine_shard" ? "Atlas Shrine Shard" : itemId[0]!.toUpperCase() + itemId.slice(1),
      iconKey: itemId,
      category: itemId === "balsam_resin" ? "consumable" : "resource",
      bestAsk: String(index + 1),
      bestBid: null,
      availableSellQuantity: "4",
      availableBuyQuantity: "0",
      lastTradePrice: null,
      bookVersion: "1"
    }));

    const { container } = render(
      <MarketCatalog
        items={items}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId="wood"
        loading={false}
        hasMore={false}
        loadingMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(container.querySelectorAll("svg")).toHaveLength(0);
    for (const itemId of itemIds) {
      const image = screen.getByAltText(itemId === "balsam_resin" ? "Balsam Resin" : itemId === "atlas_shrine_shard" ? "Atlas Shrine Shard" : itemId[0]!.toUpperCase() + itemId.slice(1));
      expect(image.getAttribute("src")).toBe(itemArtworkSource(itemId));
    }
  });

  it("counts and prices an item's Glimmer listings so a Glimmer-only item is not shown as empty", () => {
    const items: MarketItemSummary[] = [
      { ...summary("wood", null, "0"), glimmerBestAsk: "3", glimmerBestBid: null, glimmerSellQuantity: "12", glimmerBuyQuantity: "0", glimmerBookVersion: "2" },
      { ...summary("stone", "5", "4"), glimmerBestAsk: "2", glimmerBestBid: null, glimmerSellQuantity: "6", glimmerBuyQuantity: "0", glimmerBookVersion: "1" }
    ];
    render(
      <MarketCatalog
        items={items}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId={null}
        loading={false}
        hasMore={false}
        loadingMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );
    const wood = screen.getByRole("button", { name: /Wood/ });
    expect(wood.textContent).toContain("For sale 12");
    expect(wood.textContent).toContain("3 Glimmer");
    const stone = screen.getByRole("button", { name: /Stone/ });
    expect(stone.textContent).toContain("For sale 10");
    expect(stone.textContent).toContain("5 gold");
    expect(stone.textContent).toContain("or 2 Glimmer");
  });

  it("renders each Enchantment Stone card with its exact variant artwork", () => {
    const gems: MarketItemSummary[] = (["ruby", "emerald"] as const).map((variant) => ({
      ...summary("enchantment_stone", "8", "1"),
      itemIdentity: `enchantment_stone:${variant}`,
      variant,
      displayName: `${variant[0]!.toUpperCase()}${variant.slice(1)} Enchantment Stone`
    }));

    render(
      <MarketCatalog
        items={gems}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId="enchantment_stone:ruby"
        loading={false}
        hasMore={false}
        loadingMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(screen.getByAltText("Ruby Enchantment Stone").getAttribute("src"))
      .toBe(itemArtworkSource("enchantment_stone", null, "ruby"));
    expect(screen.getByAltText("Emerald Enchantment Stone").getAttribute("src"))
      .toBe(itemArtworkSource("enchantment_stone", null, "emerald"));
  });

  it("does not render non-market resources even if a stale snapshot includes them", () => {
    render(
      <MarketCatalog
        items={[summary("food"), summary("ore"), summary("water"), summary("wood", "8", "4")]}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId="wood"
        loading={false}
        hasMore={false}
        loadingMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(screen.queryByText("Food")).toBeNull();
    expect(screen.queryByText("Ore")).toBeNull();
    expect(screen.queryByText("Water")).toBeNull();
    expect(screen.getByText("Wood")).toBeTruthy();
  });

  it("shows only active external asks and subtracts the player's remaining sell quantity", () => {
    render(
      <MarketCatalog
        items={[summary("wood", "8", "9"), summary("stone", null, "12"), summary("leather", "5", "3")]}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId={null}
        loading={false}
        hasMore={false}
        loadingMore={false}
        activeOrders={[sellOrder("wood", "4"), sellOrder("leather", "3")]}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Wood Owned 0 · For sale 5/ })).toBeTruthy();
    expect(screen.queryByText("Stone")).toBeNull();
    expect(screen.queryByText("Leather")).toBeNull();
  });

  it("shows the active-listings empty state when no external asks remain", () => {
    render(
      <MarketCatalog
        items={[summary("wood", "8", "4")]}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId={null}
        loading={false}
        hasMore={false}
        loadingMore={false}
        activeOrders={[sellOrder("wood", "4")]}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(screen.getByText("No listings")).toBeTruthy();
    expect(screen.queryByText("Wood")).toBeNull();
  });

  it("uses the compact loading state when a refreshed category has no rows", () => {
    const { container } = render(
      <MarketCatalog
        items={[]}
        inventory={inventory()}
        hasInventorySnapshot
        selectedItemId={null}
        loading
        hasMore={false}
        loadingMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(screen.getByText("Loading listings…")).toBeTruthy();
    expect(container.querySelector(".market-empty.compact")).toBeTruthy();
  });

  it("loads the next bounded page from a bottom sentinel without a visible load-more button", () => {
    const intersectionCallbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersectionCallbacks.push(callback); }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    });
    const onLoadMore = vi.fn();
    const props = {
      items: [summary("wood", "8", "4")],
      inventory: inventory(),
      hasInventorySnapshot: true,
      selectedItemId: null,
      loading: false,
      hasMore: true,
      loadingMore: false,
      paginationKey: "all",
      onSelect: vi.fn(),
      onLoadMore
    };
    const view = render(<MarketCatalog {...props} />);

    expect(screen.queryByRole("button", { name: "Load more items" })).toBeNull();
    expect(intersectionCallbacks).toHaveLength(1);
    const callback = intersectionCallbacks.at(-1)!;
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onLoadMore).toHaveBeenCalledOnce();

    view.rerender(<MarketCatalog {...props} loadingMore />);
    expect(screen.getByRole("status").textContent).toBe("Loading more listings…");

    view.rerender(<MarketCatalog {...props} />);
    intersectionCallbacks.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onLoadMore).toHaveBeenCalledOnce();

    view.rerender(<MarketCatalog {...props} paginationKey="resources" />);
    intersectionCallbacks.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });
});

function summary(itemId: string, bestAsk: string | null = null, availableSellQuantity = "0"): MarketItemSummary {
  return {
    itemId,
    itemIdentity: itemId,
    displayName: itemId[0]!.toUpperCase() + itemId.slice(1),
    iconKey: itemId,
    category: "resource",
    bestAsk,
    bestBid: null,
    availableSellQuantity,
    availableBuyQuantity: "0",
    lastTradePrice: null,
    bookVersion: "0"
  };
}

function sellOrder(itemId: string, remainingQuantity: string): MarketOrderSnapshot {
  return {
    orderId: `${itemId}-sell-order`,
    itemId,
    itemIdentity: itemId,
    displayName: itemId,
    side: "sell",
    policy: "gtc",
    unitPrice: "8",
    originalQuantity: remainingQuantity,
    filledQuantity: "0",
    remainingQuantity,
    status: "open",
    prioritySequence: "1",
    createdAt: "2026-08-25T00:00:00.000Z",
    cancelledAt: null,
    completedAt: null
  };
}

function inventory(): PlayerInventorySnapshot {
  return {
    playerId: "catalog-test-player",
    revision: 1,
    items: [],
    totals: {
      wood: 0,
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
