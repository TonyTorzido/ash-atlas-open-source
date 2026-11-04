// @vitest-environment jsdom
import type { WikiBuiltInArticle, WikiBuiltInContent } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WikiApp } from "./WikiApp.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  window.history.replaceState({}, "", "/wiki");
});

describe("WikiApp", () => {
  it("shows signed-out visitors a sign-in state without any wiki content or content requests", async () => {
    const fetchMock = fetchFixture(false, "none");
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/wiki/getting-started/controls");
    const { container } = render(<WikiApp />);
    expect(screen.getByRole("status").textContent).toContain("Checking your access");
    expect(await screen.findByRole("heading", { name: "Sign in to read the wiki" })).toBeTruthy();
    expect(screen.getByRole<HTMLAnchorElement>("link", { name: "Sign in" }).getAttribute("href")).toBe("/play/");
    expect(container.querySelector(".game-app-shell")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Controls & How to Play" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Wiki articles" })).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/api/auth/session"]);
  });

  it.each([
    [{ testAccessAllowed: false }, "Waiting for test access"],
    [{ testAccessAllowed: false, testAccessDevOnly: true }, "Developer access only"]
  ])("keeps signed-in accounts outside the test-access gate out of the wiki (%o)", async (gate, heading) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/auth/session") return response({ authenticated: true, csrfToken: "csrf", developmentAuthEnabled: false, ...gate });
      return fetchFixtureResponse(pathname, true, "none");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WikiApp />);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Welcome to the Ash Atlas Wiki." })).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/api/auth/session"]);
  });

  it("drops back to the sign-in state when the wiki API rejects the session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/wiki") return response({ error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" } }, 401);
      return fetchFixtureResponse(pathname, true, "none");
    }));
    render(<WikiApp />);
    expect(await screen.findByRole("heading", { name: "Sign in to read the wiki" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Welcome to the Ash Atlas Wiki." })).toBeNull();
  });

  it("lets approved players browse without showing edit controls", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "none"));
    const { container } = render(<WikiApp />);
    expect(await screen.findByRole("button", { name: /Getting Started/ })).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".game-app-shell")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create article" })).toBeNull();
  });

  it("shows content controls to authenticated editors", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "editor"));
    render(<WikiApp />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create article" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Team" })).toBeNull();
  });

  it("reuses a pending operation key after an uncertain failure and clears it after success", async () => {
    const operationKeys: string[] = [];
    let mutationAttempt = 0;
    const randomUUID = vi.fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    vi.stubGlobal("crypto", { randomUUID });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/wiki" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { operationKey: string; slug: string };
        operationKeys.push(payload.operationKey); mutationAttempt += 1;
        if (mutationAttempt === 1) return response({ error: { code: "WIKI_UNAVAILABLE", message: "Response was lost" } }, 503);
        return response({ page: { ...article, slug: payload.slug, title: payload.slug === "second-page" ? "Second Page" : article.title }, replayed: mutationAttempt === 2 });
      }
      return fetchFixtureResponse(pathname, true, "editor");
    }));
    render(<WikiApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Create article" }));
    fillDraft("getting-started", "Getting Started");
    fireEvent.click(screen.getByRole("button", { name: "Create article" }));
    await waitFor(() => expect(operationKeys).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Create article" }));
    await waitFor(() => expect(operationKeys).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "Create article" }));
    fillDraft("second-page", "Second Page");
    fireEvent.click(screen.getByRole("button", { name: "Create article" }));
    await waitFor(() => expect(operationKeys).toHaveLength(3));
    expect(operationKeys).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
  });

  it("synchronizes the reader when browser history changes", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "none"));
    render(<WikiApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Getting Started/ }));
    expect(await screen.findByRole("heading", { name: "Getting Started" })).toBeTruthy();
    window.history.replaceState({}, "", "/wiki");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "Welcome to the Ash Atlas Wiki." })).toBeTruthy();
    window.history.replaceState({}, "", "/wiki/getting-started");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "Getting Started" })).toBeTruthy();
  });

  it("serves a built-in guide directly without requiring a stored API page", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "none", []));
    window.history.replaceState({}, "", "/wiki/getting-started/controls");
    render(<WikiApp />);
    expect(await screen.findByRole("heading", { name: "Controls & How to Play" })).toBeTruthy();
    // Players never see developer provenance or routes.
    expect(screen.queryByText(/Curated|Generated from game data|Route:|source-backed/i)).toBeNull();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Getting started");
    expect(screen.getByRole("link", { name: "First steps in the world" }).getAttribute("href")).toBe("/wiki/getting-started/first-steps");
    expect(screen.getByRole("heading", { name: "Move and read the map" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Drag the map" })).toBeTruthy();
  });

  it("renders the server-sent roster and matchup explorer with their data, and drops unknown tags", async () => {
    const fetchMock = fetchFixture(true, "none", []);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/wiki/world/creatures");
    const { container } = render(<WikiApp />);
    expect(await screen.findByRole("heading", { name: "Creatures and the Encyclopedia" })).toBeTruthy();
    expect(screen.getByTestId("creature-wolf").textContent).toContain("Bite (Dagger) · Fur (Tunic)");
    expect(container.querySelector("script, iframe")).toBeNull();
    expect(container.textContent).not.toContain("never rendered");
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.filter((path) => path.startsWith("/api/wiki/"))).toEqual([]);

    window.history.replaceState({}, "", "/wiki/character/matchups");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("group", { name: "Explore matchups by" })).toBeTruthy();
  });

  it("keeps built-in guides available when the API has no pages", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "none", []));
    render(<WikiApp />);
    expect(await screen.findByRole("heading", { name: "Welcome to the Ash Atlas Wiki." })).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /Controls & How to Play/ })).length).toBeGreaterThan(0);
    expect(screen.queryByText("Wiki in progress")).toBeNull();
  });

  it("welcomes new players and exposes every built-in topic from the homepage", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "none", []));
    render(<WikiApp />);
    expect(await screen.findByRole("heading", { name: "Welcome to the Ash Atlas Wiki." })).toBeTruthy();
    expect(screen.getByAltText("Ash Atlas field guide artwork").getAttribute("src")).toBe("/landing/ash-atlas-landing-desktop.webp");
    expect(screen.getByRole("link", { name: "Ash Atlas Player Wiki" }).querySelector(".wiki-brand-mark")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start with the player loop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start here" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose your path" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Browse every topic" })).toBeTruthy();
    await screen.findAllByRole("button", { name: /Controls & How to Play/ });
    for (const article of BUILT_IN.articles) {
      expect(screen.getAllByRole("link", { name: new RegExp(article.title) }).some((link) => link.getAttribute("href") === `/wiki/${article.slug}`)).toBe(true);
    }
  });

  it("keeps no-match search results distinct from an empty wiki", async () => {
    vi.stubGlobal("fetch", fetchFixture(true, "none"));
    render(<WikiApp />);
    await screen.findByRole("button", { name: /Getting Started/ });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search articles" }), { target: { value: "missing" } });
    expect(screen.getByText("No articles found")).toBeTruthy();
    expect(screen.getByText("Try another search.")).toBeTruthy();
    expect(screen.queryByText("Wiki in progress")).toBeNull();
  });

  it("cancels collaborator removal without sending a delete request", async () => {
    const fetchMock = fetchFixture(true, "owner");
    vi.stubGlobal("fetch", fetchMock);
    render(<WikiApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Team" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("heading", { name: "Remove Rowan from the wiki team?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Remove Rowan from the wiki team?" })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});

const article = { slug: "getting-started", title: "Getting Started", summary: "Begin", body: "# Welcome", currentRevision: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

function fetchFixture(authenticated: boolean, access: "none" | "editor" | "owner", pages: unknown[] = [{ slug: article.slug, title: article.title, summary: article.summary, currentRevision: 1, updatedAt: article.updatedAt }]) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/wiki") return response({ pages, builtIn: BUILT_IN });
    return fetchFixtureResponse(pathname, authenticated, access);
  });
}
function fetchFixtureResponse(pathname: string, authenticated: boolean, access: "none" | "editor" | "owner"): Response {
  if (pathname === "/api/wiki") return response({ pages: [{ slug: article.slug, title: article.title, summary: article.summary, currentRevision: 1, updatedAt: article.updatedAt }], builtIn: BUILT_IN });
  if (pathname === "/api/wiki/getting-started") return response(article);
  if (pathname === "/api/auth/session") return response({ authenticated, csrfToken: authenticated ? "csrf" : "", developmentAuthEnabled: false, ...(authenticated ? { testAccessAllowed: true } : {}) });
  if (pathname === "/api/wiki-access") return response({ access, implicitDeveloperOwner: false });
  if (pathname === "/api/wiki-team") return response({ collaborators: [{ accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", playerName: "Rowan", role: "editor", grantedAt: article.updatedAt }] });
  return response({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
}
function fillDraft(slug: string, title: string): void {
  fireEvent.change(screen.getByLabelText("URL slug"), { target: { value: slug } });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "A useful summary" } });
  fireEvent.change(screen.getByLabelText(/Article text/), { target: { value: "Useful article text" } });
}
function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const link = (slug: string, text: string) => ({ t: "WikiLink", p: { slug }, c: [text] });
const built = (slug: string, title: string, category: WikiBuiltInArticle["category"], content: WikiBuiltInArticle["content"]): WikiBuiltInArticle =>
  ({ slug, title, summary: `${title} summary`, category, tags: [], content });
/** Shape of the signed-in `builtIn` block the server sends with GET /api/wiki. */
const BUILT_IN: WikiBuiltInContent = {
  categories: [
    { id: "getting-started", label: "Getting started", description: "Controls, menus, and your first steps." },
    { id: "world", label: "World", description: "Travel, time, creatures, and gathering." },
    { id: "character", label: "Character", description: "Combat, matchups, levels, gear, and your pack." }
  ],
  articles: [
    built("getting-started/controls", "Controls & How to Play", "getting-started", { t: "", c: [
      { t: "p", c: ["Keep this page open while you play."] },
      { t: "aside", p: { className: "wiki-callout wiki-callout-tip" }, c: [{ t: "strong", c: ["Start here"] }, { t: "div", c: [link("getting-started/first-steps", "First steps in the world")] }] },
      { t: "h2", c: ["Move and read the map"] },
      { t: "div", p: { className: "wiki-table-wrap" }, c: [{ t: "table", p: { className: "wiki-table" }, c: [{ t: "tbody", c: [{ t: "tr", c: [{ t: "td", c: ["Drag the map"] }, { t: "td", c: ["Pan the view."] }] }] }] }] },
      { t: "script", c: ["never rendered"] }
    ] }),
    built("getting-started/first-steps", "First Steps in the World", "getting-started", { t: "p", c: ["Find your bearings."] }),
    built("world/creatures", "Creatures and the Encyclopedia", "world", { t: "", c: [
      { t: "CreatureRoster", p: { creatures: [{
        key: "wolf", name: "Wolf", bookRarity: "uncommon", fixedLevel: null, maxHealth: 36, weaponName: "Bite", weaponType: "Dagger", weaponTypeId: "dagger",
        armorName: "Fur", armorType: "Tunic", armorTypeId: "martial_tunic", damageMultiplier: 1
      }] } },
      { t: "iframe", p: { src: "https://example.invalid" } }
    ] }),
    built("character/matchups", "Weapon & Armor Matchups", "character", { t: "MatchupExplorer", p: { matchups: {
      armors: [{ id: "unarmored", name: "Unarmored", shield: false, artItemId: null }, { id: "martial_tunic", name: "Tunic", shield: false, artItemId: null }],
      weapons: [{ id: "dagger", name: "Dagger", inGame: true, artItemId: null, values: [10, 9] }],
      monsters: [{ key: "wolf", name: "Wolf", boss: false, weaponName: "Bite", weaponTypeId: "dagger", weaponType: "Dagger", armorName: "Fur", armorTypeId: "martial_tunic", armorType: "Tunic", damageMultiplier: 1 }]
    } } })
  ]
};
