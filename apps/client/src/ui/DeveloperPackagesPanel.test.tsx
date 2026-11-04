// @vitest-environment jsdom
import {
  PLAYER_PACKAGE_ADMIN_API_BASE,
  type PlayerPackageCatalogItem
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperPackagesPanel } from "./DeveloperPackagesPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeveloperPackagesPanel route and load states", () => {
  it("uses the admin route base and never represents a non-JSON 404 as zero characters", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const pathname = requestUrl(input).pathname;
      if (pathname === `${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`) {
        return new Response("<h1>Not Found</h1>", {
          status: 404,
          headers: { "content-type": "text/html" }
        });
      }
      return jsonResponse({ campaigns: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);

    expect(screen.getByRole("option", {
      name: "All existing characters (loading…)"
    })).toBeTruthy();
    expect(await screen.findByText(/Character list unavailable\./)).toBeTruthy();
    expect(screen.queryByRole("option", {
      name: "All existing characters (0)"
    })).toBeNull();
    expect((screen.getByRole("button", {
      name: "Review and send"
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      `${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`,
      `${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`
    ]);
  });

  it("displays a genuine successful zero-character count", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      return requestUrl(input).pathname.endsWith("/catalog")
        ? jsonResponse({ items: [woodCatalogItem], eligibleCharacterCount: 0 })
        : jsonResponse({ campaigns: [] });
    }));

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);

    expect(await screen.findByRole("option", {
      name: "All existing characters (0)"
    })).toBeTruthy();
    expect(screen.queryByText(/Character list unavailable/)).toBeNull();
  });

  it("preserves a successful catalog and count when campaign history fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      return requestUrl(input).pathname.endsWith("/catalog")
        ? jsonResponse({ items: [woodCatalogItem], eligibleCharacterCount: 3 })
        : new Response("upstream unavailable", { status: 503 });
    }));

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);

    expect(await screen.findByRole("option", {
      name: "All existing characters (3)"
    })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Wood · resource" })).toBeTruthy();
    expect(await screen.findByText(/Campaign history unavailable\./)).toBeTruthy();
    expect(screen.queryByText(/Character list unavailable/)).toBeNull();
  });

  it("reports character-search failure without erasing selected recipients", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/catalog")) {
        return jsonResponse({ items: [woodCatalogItem], eligibleCharacterCount: 3 });
      }
      if (url.pathname.endsWith("/campaigns")) return jsonResponse({ campaigns: [] });
      if (url.searchParams.get("search") === "Ranger") {
        return jsonResponse({
          characters: [{
            playerId: "ranger-player",
            displayName: "Ranger",
            identityHint: "r-player",
            online: true
          }],
          nextCursor: null
        });
      }
      return new Response("search unavailable", { status: 503 });
    }));

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);
    const search = await screen.findByRole("combobox", { name: "Find character" });
    fireEvent.change(search, { target: { value: "Ranger" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Ranger/ }));
    expect(screen.getByTitle("Remove recipient")).toBeTruthy();

    fireEvent.change(search, { target: { value: "Unavailable" } });
    expect(await screen.findByText(/Character search failed\./)).toBeTruthy();
    expect(screen.getByTitle("Remove recipient")).toBeTruthy();
  });

  it("browses blank-query pages and supports keyboard selection without duplicates", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/catalog")) {
        return jsonResponse({
          items: [woodCatalogItem, goldCatalogItem, cityCoinCatalogItem],
          eligibleCharacterCount: 2
        });
      }
      if (url.pathname.endsWith("/campaigns")) {
        return jsonResponse({ campaigns: [] });
      }
      if (url.searchParams.get("cursor") === "1") {
        return jsonResponse({
          characters: [{
            playerId: "second-player",
            displayName: "Second Ranger",
            identityHint: "d-player",
            online: false
          }],
          nextCursor: null
        });
      }
      return jsonResponse({
        characters: [{
          playerId: "first-player",
          displayName: "First Ranger",
          identityHint: "t-player",
          online: true
        }],
        nextCursor: "1"
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);
    const search = await screen.findByRole("combobox", { name: "Find character" });
    fireEvent.focus(search);
    expect(await screen.findByRole("option", { name: /First Ranger/ })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) =>
      requestUrl(input).pathname.endsWith("/characters") &&
      requestUrl(input).searchParams.get("search") === ""
    )).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Load more characters" }));
    expect(await screen.findByRole("option", { name: /Second Ranger/ })).toBeTruthy();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getAllByTitle("Remove recipient")).toHaveLength(1);
    fireEvent.focus(search);
    expect(screen.queryByRole("option", { name: /First Ranger/ })).toBeNull();
    fireEvent.click(screen.getByTitle("Remove recipient"));
    expect(screen.queryByTitle("Remove recipient")).toBeNull();
  });

  it("adds, edits, removes, reviews, and submits Gold and City Coins as currencies", async () => {
    const fetchMock = vi.fn(async (
      input: URL | RequestInfo,
      init?: RequestInit
    ) => {
      const url = requestUrl(input);
      if (init?.method === "POST") {
        return jsonResponse({
          campaignId: "campaign",
          recipientCount: 1,
          replayed: false
        });
      }
      if (url.pathname.endsWith("/catalog")) {
        return jsonResponse({
          items: [woodCatalogItem, goldCatalogItem, cityCoinCatalogItem],
          eligibleCharacterCount: 1
        });
      }
      if (url.pathname.endsWith("/characters")) {
        return jsonResponse({
          characters: [{
            playerId: "ranger",
            displayName: "Ranger",
            identityHint: "ranger",
            online: true
          }],
          nextCursor: null
        });
      }
      return jsonResponse({ campaigns: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);
    const character = await screen.findByRole("combobox", {
      name: "Find character"
    });
    fireEvent.focus(character);
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Ranger/ }));

    const asset = screen.getByRole("combobox", { name: "Asset" });
    fireEvent.change(asset, { target: { value: "gold" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity" }), {
      target: { value: "10" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add asset" }));
    fireEvent.change(asset, { target: { value: "city_coins" } });
    fireEvent.click(screen.getByRole("button", { name: "Add asset" }));
    fireEvent.change(screen.getByLabelText("Quantity for gold"), {
      target: { value: "25" }
    });
    expect(screen.getAllByText("Currency value grant")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    expect(screen.queryByLabelText("Quantity for city_coins")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add asset" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Currency package" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Review and send" }));
    expect(screen.getByText(/25 × Gold/)).toBeTruthy();
    expect(screen.getByText(/10 × City Coins/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to 1" }));
    expect(await screen.findByText(/Package campaign created/)).toBeTruthy();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeTruthy();
    const payload = JSON.parse(String(post?.[1]?.body)) as {
      items: PackageLineForTest[];
    };
    expect(payload.items).toEqual(expect.arrayContaining([
      {
        itemKind: "gold",
        itemId: "gold",
        variant: null,
        quantity: 25
      },
      {
        itemKind: "city_coins",
        itemId: "city_coins",
        variant: null,
        quantity: 10
      }
    ]));
  });

  it("adds the visible filtered ring instead of the previously selected Gold asset", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      return requestUrl(input).pathname.endsWith("/catalog")
        ? jsonResponse({
            items: [goldCatalogItem, choppingRingCatalogItem],
            eligibleCharacterCount: 1
          })
        : jsonResponse({ campaigns: [] });
    }));

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);
    expect(await screen.findByRole("option", { name: "Gold · currency" })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter assets" }), {
      target: { value: "ring" }
    });
    expect((screen.getByRole("combobox", { name: "Asset" }) as HTMLSelectElement).value)
      .toBe("chopping_ring");
    fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

    expect(screen.getByText("Chopping Ring")).toBeTruthy();
    expect(screen.getByText("Physical ring")).toBeTruthy();
    expect(screen.queryByText("Currency value grant")).toBeNull();
  });

  it("finds every gemstone and adds all eight named variants", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      return requestUrl(input).pathname.endsWith("/catalog")
        ? jsonResponse({ items: [gemstoneCatalogItem], eligibleCharacterCount: 1 })
        : jsonResponse({ campaigns: [] });
    }));

    render(<DeveloperPackagesPanel serverHttpBase="https://playashatlas.com" csrfToken="csrf" />);
    await screen.findByRole("option", { name: "Enchantment Stone · resource" });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter assets" }), {
      target: { value: "topaz" }
    });
    expect(screen.getByRole("combobox", { name: "Asset" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Gemstone" }) as HTMLSelectElement).value)
      .toBe("topaz");
    expect(screen.getAllByRole("option", {
      name: /Diamond|Onyx|Opal|Amethyst|Topaz|Sapphire|Ruby|Emerald/u
    })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Add asset" }));
    expect(screen.getByText("Topaz Enchantment Stone")).toBeTruthy();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity" }), {
      target: { value: "2" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add all 8 gemstones" }));

    for (const variant of gemstoneCatalogItem.supportedVariants) {
      expect(screen.getByText(`${humanizeForTest(variant)} Enchantment Stone`)).toBeTruthy();
      expect(screen.getByLabelText(`Quantity for enchantment_stone:${variant}`)).toBeTruthy();
    }
  });
});

type PackageLineForTest = {
  itemKind: string;
  itemId: string;
  variant: string | null;
  quantity: number;
};

const woodCatalogItem: PlayerPackageCatalogItem = {
  itemId: "wood",
  kind: "resource",
  assetType: "physical",
  displayName: "Wood",
  category: "resource",
  iconKey: "wood",
  stackable: true,
  maxStack: 250,
  supportedVariants: ["default"],
  packageGrantable: true
};

const goldCatalogItem: PlayerPackageCatalogItem = {
  itemId: "gold",
  kind: "gold",
  assetType: "currency",
  displayName: "Gold",
  category: "currency",
  iconKey: "gold",
  stackable: true,
  maxStack: 10_000,
  supportedVariants: [],
  packageGrantable: true
};

const cityCoinCatalogItem: PlayerPackageCatalogItem = {
  ...goldCatalogItem,
  itemId: "city_coins",
  kind: "city_coins",
  displayName: "City Coins",
  iconKey: "city_coins"
};

const choppingRingCatalogItem: PlayerPackageCatalogItem = {
  itemId: "chopping_ring",
  kind: "equipment",
  assetType: "physical",
  displayName: "Chopping Ring",
  category: "ring",
  iconKey: "chopping_ring",
  stackable: false,
  maxStack: 1,
  supportedVariants: ["default"],
  packageGrantable: true
};

const gemstoneCatalogItem: PlayerPackageCatalogItem = {
  itemId: "enchantment_stone",
  kind: "resource",
  assetType: "physical",
  displayName: "Enchantment Stone",
  category: "resource",
  iconKey: "enchantment_stone",
  stackable: false,
  maxStack: 1,
  supportedVariants: [
    "diamond",
    "onyx",
    "opal",
    "amethyst",
    "topaz",
    "sapphire",
    "ruby",
    "emerald"
  ],
  packageGrantable: true
};

function humanizeForTest(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function requestUrl(input: URL | RequestInfo): URL {
  return new URL(typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url);
}
