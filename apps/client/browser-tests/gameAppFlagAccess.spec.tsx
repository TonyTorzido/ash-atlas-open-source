import type { FlagAccessSnapshot } from "@ash-atlas/shared";
import { expect, test } from "@playwright/experimental-ct-react";
import type { Page, Route } from "@playwright/test";

import { GameAppFlagAccessStory } from "./GameAppFlagAccessStory.js";

const OWNER_FLAG_ID = "11111111-1111-4111-8111-111111111111";
const VISITOR_FLAG_ID = "22222222-2222-4222-8222-222222222222";

test.beforeEach(async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<GameAppFlagAccessStory />);
  await expect.poll(() => page.evaluate(() => window.gameAppFlagHarnessReady)).toBe(true);
});

test("keeps the real phone action sheet absent until allowed access resolves", async ({
  page
}) => {
  const requests = await holdAccessRequests(page);
  await observeVisibleMenus(page);

  await selectFlag(page, OWNER_FLAG_ID);
  await expect.poll(() => requests.has(OWNER_FLAG_ID)).toBe(true);
  await expect(page.locator(".mobile-world-action-sheet")).toHaveCount(0);
  await expect(page.locator(".mobile-world-action-primary")).toHaveCount(0);
  await expect(page.getByText("Checking Access", { exact: true })).toHaveCount(0);

  await fulfillAccess(requests, ownerAccess());
  await expect(page.getByLabel("Scout's Flag (Public) · Free actions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  expect(await visibleMenuMutations(page)).toEqual([
    expect.stringContaining("Scout'sFlag(Public)·FreeJumpMoreCancel")
  ]);
  expect((await visibleMenuMutations(page)).join(" ")).not.toContain("Checking Access");
});

test("opens for the first time with the authoritative toll label", async ({ page }) => {
  const requests = await holdAccessRequests(page);
  await observeVisibleMenus(page);

  await selectFlag(page, OWNER_FLAG_ID);
  await expect.poll(() => requests.has(OWNER_FLAG_ID)).toBe(true);
  await fulfillAccess(requests, ownerAccess("7"));

  await expect(page.getByRole("button", { name: /Jump.*7 Gold/ })).toBeVisible();
  const mutations = await visibleMenuMutations(page);
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatch(/Jump.*7Gold/);
  expect(mutations[0]).not.toContain("JumpMore");
});

test("ignores a slower stale response after a newer flag is selected", async ({
  page
}) => {
  const requests = await holdAccessRequests(page);

  await selectFlag(page, OWNER_FLAG_ID);
  await expect.poll(() => requests.has(OWNER_FLAG_ID)).toBe(true);
  await selectFlag(page, VISITOR_FLAG_ID);
  await expect.poll(() => requests.has(VISITOR_FLAG_ID)).toBe(true);
  await fulfillAccess(requests, ownerAccess()).catch(() => undefined);
  await expect(page.locator(".mobile-world-action-sheet")).toHaveCount(0);
  await fulfillAccess(requests, visitorAccess());
  await expect(page.getByLabel("Ranger's Flag (Normal) · Free actions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request Access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
});

test("resets local access state when switching directly between cached flags", async ({
  page
}) => {
  const requests = await holdAccessRequests(page);

  await selectFlag(page, OWNER_FLAG_ID);
  await expect.poll(() => requests.has(OWNER_FLAG_ID)).toBe(true);
  await fulfillAccess(requests, ownerAccess());
  await expect(page.getByLabel("Scout's Flag (Public) · Free actions")).toBeVisible();

  await selectFlag(page, VISITOR_FLAG_ID);
  await expect.poll(() => requests.has(VISITOR_FLAG_ID)).toBe(true);
  await fulfillAccess(requests, visitorAccess());
  await expect(page.getByLabel("Ranger's Flag (Normal) · Free actions")).toBeVisible();

  await selectFlag(page, OWNER_FLAG_ID);
  await expect(page.getByLabel("Scout's Flag (Public) · Free actions")).toBeVisible();
  await observeVisibleMenus(page);
  await selectFlag(page, VISITOR_FLAG_ID);
  await expect(page.getByLabel("Ranger's Flag (Normal) · Free actions")).toBeVisible();

  const mutations = await visibleMenuMutations(page);
  const visitorMutations = mutations.filter((text) => text.includes("Ranger'sFlag"));
  expect(visitorMutations).toEqual([
    expect.stringContaining("Ranger'sFlag(Normal)·FreeRequestAccessCancel")
  ]);
});

test("leaves no sheet behind when access resolution fails", async ({ page }) => {
  const requests = await holdAccessRequests(page);
  await selectFlag(page, OWNER_FLAG_ID);
  await expect.poll(() => requests.has(OWNER_FLAG_ID)).toBe(true);
  await requests.get(OWNER_FLAG_ID)!.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: "Flag access unavailable." } })
  });

  await expect(page.getByRole("alert")).toContainText("Flag access unavailable.");
  await expect(page.locator(".mobile-world-action-sheet")).toHaveCount(0);
  await expect(page.locator(".mobile-world-action-primary")).toHaveCount(0);
  await expect(page.getByText("Checking Access", { exact: true })).toHaveCount(0);
});

async function holdAccessRequests(page: Page): Promise<Map<string, Route>> {
  const requests = new Map<string, Route>();
  await page.route("**/api/flags/*/access", async (route) => {
    const match = new URL(route.request().url()).pathname.match(
      /^\/api\/flags\/([^/]+)\/access$/
    );
    if (!match) {
      await route.fallback();
      return;
    }
    requests.set(decodeURIComponent(match[1]!), route);
  });
  return requests;
}

async function fulfillAccess(
  requests: Map<string, Route>,
  access: FlagAccessSnapshot
): Promise<void> {
  const route = requests.get(access.flagId);
  if (!route) throw new Error(`No held access request for ${access.flagId}.`);
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ access })
  });
}

async function selectFlag(page: Page, flagId: string): Promise<void> {
  await page.evaluate((id) => window.selectGameAppFlag(id), flagId);
}

async function observeVisibleMenus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observed: string[] = [];
    const record = (): void => {
      const sheet = document.querySelector(".mobile-world-action-sheet");
      if (!sheet) return;
      const text = sheet.textContent?.replace(/\s+/g, "") ?? "";
      if (text && observed.at(-1) !== text) observed.push(text);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.__flagMenuMutationObserver?.disconnect();
    window.__flagMenuMutationObserver = observer;
    window.__flagMenuMutations = observed;
  });
}

async function visibleMenuMutations(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__flagMenuMutations ?? []);
}

function ownerAccess(tollGold = "0"): FlagAccessSnapshot {
  return access(OWNER_FLAG_ID, "player-1", {
    allowed: true,
    requestable: false,
    reasonCode: "ALLOWED_OWNER",
    tollGold
  });
}

function visitorAccess(): FlagAccessSnapshot {
  return access(VISITOR_FLAG_ID, "player-2", {
    allowed: false,
    requestable: true,
    reasonCode: "NORMAL_PASSAGE_REQUIRED",
    tollGold: "0"
  });
}

function access(
  flagId: string,
  ownerPlayerId: string,
  decision: FlagAccessSnapshot["decision"]
): FlagAccessSnapshot {
  return {
    flagId,
    ownerPlayerId,
    mode: decision.allowed ? "public" : "normal",
    jumpTollGold: decision.tollGold,
    accessRevision: "1",
    requestPending: false,
    decision,
    management: { pendingRequests: [] }
  };
}

declare global {
  interface Window {
    __flagMenuMutationObserver?: MutationObserver;
    __flagMenuMutations?: string[];
  }
}
