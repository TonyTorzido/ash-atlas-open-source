import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
const executablePath = process.env.ASH_ATLAS_CHROMIUM_EXECUTABLE;

test("a retained Android profile repairs chat suppression and migrates to gameplay", async () => {
  test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must identify a disposable full-app runtime");
  const profile = await mkdtemp(join(tmpdir(), "ash-atlas-android-hud-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      hasTouch: true,
      isMobile: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
        "Chrome/126.0.0.0 Mobile Safari/537.36"
    });
    const page = context.pages()[0] ?? await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await enterDisposableGame(page);

    await page.getByRole("button", { name: "Open General chat" }).click();
    await expect(page.locator(".mobile-chat-overlay")).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".phone-hud")).toBeVisible();
    await expect(page.locator(".chat-top-bar")).toBeVisible();
    await page.getByRole("button", { name: "Open General chat" }).click();
    await page.getByRole("button", { name: "Close chat panel" }).click();
    await expect(page.locator(".phone-hud")).toBeVisible();
    await expect(page.locator(".chat-top-bar")).toBeVisible();

    await page.evaluate(() => {
      const hud = document.querySelector<HTMLElement>(".phone-hud")!;
      document.documentElement.dataset.mobileChatProtected = "true";
      hud.dataset.chatSuppressed = "true";
      hud.setAttribute("inert", "");
      hud.setAttribute("aria-hidden", "true");
    });
    await expect.poll(() => readHudInvariant(page)).toEqual({
      rootProtected: false,
      ownerCount: 0,
      hudSuppressed: false,
      hudInert: false,
      hudHidden: false
    });

    await page.getByRole("button", { name: "Open General chat" }).click();
    await page.goBack();
    await expect(page.locator(".phone-hud")).toBeVisible();
    await page.setViewportSize({ width: 412, height: 760 });
    await page.setViewportSize({ width: 412, height: 915 });
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => readHudInvariant(page)).toMatchObject({
      rootProtected: false,
      ownerCount: 0,
      hudHidden: false
    });

    const retained = await page.evaluate(() => {
      const currentKey = Object.keys(localStorage)
        .find((key) => key.startsWith("ash-atlas:presentation:v2:"));
      if (!currentKey) throw new Error("active disposable player presentation key was absent");
      const playerId = currentKey.slice("ash-atlas:presentation:v2:".length);
      const map = JSON.parse(localStorage.getItem(currentKey) ?? "null")?.map;
      if (!map) throw new Error("active disposable player map presentation was absent");
      localStorage.removeItem(currentKey);
      localStorage.setItem(`ash-atlas:presentation:v1:${playerId}`, JSON.stringify({
        version: 1,
        map,
        mobileView: "messages"
      }));
      localStorage.setItem("unrelated-retained-test", "preserve-me");
      localStorage.setItem("ashAtlas.ui.layout", "compact");
      localStorage.setItem("ashAtlas.chat.selectedChannel", "public:general");
      history.replaceState({
        ashAtlasMobileMenuView: "messages",
        ashAtlasChatOverlay: true,
        unrelated: "preserve-me"
      }, "", location.href);
      return { playerId, map };
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".phone-hud")).toBeVisible();
    await expect(page.locator(".chat-top-bar")).toBeVisible();
    await expect(page.locator(".game-shell")).toHaveAttribute(
      "data-mobile-menu-view",
      "gameplay"
    );
    expect(await page.evaluate((playerId) => ({
      legacy: localStorage.getItem(`ash-atlas:presentation:v1:${playerId}`),
      current: JSON.parse(
        localStorage.getItem(`ash-atlas:presentation:v2:${playerId}`) ?? "null"
      ),
      unrelatedStorage: localStorage.getItem("unrelated-retained-test"),
      layout: localStorage.getItem("ashAtlas.ui.layout"),
      selectedChannel: localStorage.getItem("ashAtlas.chat.selectedChannel"),
      history: history.state
    }), retained.playerId)).toEqual({
      legacy: null,
      current: {
        version: 2,
        map: retained.map
      },
      unrelatedStorage: "preserve-me",
      layout: "compact",
      selectedChannel: "public:general",
      history: { unrelated: "preserve-me" }
    });

    await page.getByRole("button", { name: "Open Game Menu" }).click();
    await page.getByRole("button", { name: "Miscellaneous" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Default Dev" }).click();
    await expect(page.locator(".phone-hud")).toBeVisible();
    expect(await page.evaluate(() => ({
      unrelatedStorage: localStorage.getItem("unrelated-retained-test"),
      layout: localStorage.getItem("ashAtlas.ui.layout"),
      selectedChannel: localStorage.getItem("ashAtlas.chat.selectedChannel")
    }))).toEqual({
      unrelatedStorage: "preserve-me",
      layout: "compact",
      selectedChannel: "public:general"
    });

    const expectedBuild = "b".repeat(40);
    await page.goto(`${baseUrl}?update=${expectedBuild}.3.123`, {
      waitUntil: "domcontentloaded"
    });
    await expect(page.getByRole("heading", { name: "Ash Atlas has been updated" }))
      .toBeVisible();
    await expect(page.getByText("The browser could not finish the update automatically."))
      .toBeVisible();
    await expect(page.locator(".phone-hud")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("unrelated-retained-test")))
      .toBe("preserve-me");
    expect(pageErrors).toEqual([]);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function enterDisposableGame(page: Page): Promise<void> {
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const hud = page.locator(".phone-hud");
  const devLogin = page.getByRole("button", { name: "Default Dev" });
  if (!await hud.isVisible()) {
    await devLogin.waitFor({ state: "visible", timeout: 15_000 });
    await devLogin.click();
  }
  const createPlayer = page.getByRole("heading", { name: "Create your player" });
  await hud.or(createPlayer).waitFor({ state: "visible", timeout: 15_000 });
  if (await createPlayer.isVisible()) {
    await page.getByRole("textbox", { name: "Display name" }).fill("AndroidTester");
    await page.getByRole("radio", { name: "Gold" }).check();
    const createButton = page.getByRole("button", { name: "Create Player" });
    await expect(createButton).toBeEnabled();
    await createButton.click();
  }
  await expect(hud).toBeVisible({ timeout: 30_000 });
}

async function readHudInvariant(page: Page): Promise<{
  rootProtected: boolean;
  ownerCount: number;
  hudSuppressed: boolean;
  hudInert: boolean;
  hudHidden: boolean;
}> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>(".phone-hud")!;
    const style = getComputedStyle(hud);
    return {
      rootProtected: document.documentElement.dataset.mobileChatProtected === "true",
      ownerCount: document.querySelectorAll(
        '[data-mobile-chat-protection-owner="true"]'
      ).length,
      hudSuppressed: hud.dataset.chatSuppressed === "true",
      hudInert: hud.hasAttribute("inert"),
      hudHidden: style.display === "none" || style.visibility === "hidden"
    };
  });
}
