import { expect, test } from "@playwright/experimental-ct-react";
import { PhoneHudLayoutStory } from "./PhoneHudLayoutStory.js";
import { FloatingMessagesStory } from "./MessagesNavigationStory.js";
import { PresentationPreviewStory } from "./PresentationPreviewStory.js";

for (const size of [{ width: 1100, height: 600 }, { width: 1164, height: 637 }, { width: 1180, height: 645 }, { width: 1440, height: 1000 }]) {
  for (const surface of ["inventory", "inventory-route", "settings", "party", "chat"] as const) test(`developer presentation preview: ${surface} at ${size.width}x${size.height}`, async ({ page, mount }, testInfo) => {
    await page.setViewportSize(size);
    const view = await mount(<PresentationPreviewStory surface={surface} />);
    const preview = page.getByRole("combobox", { name: "Presentation preview" });
    await expect(preview).toHaveValue("auto");
    if (surface !== "settings") await expect(page.getByRole("navigation", { name: "Game commands" })).toBeVisible();
    const dialog = page.getByRole("dialog").last();
    const assertBounded = async (): Promise<void> => {
      const stage = await page.getByTestId("mobile-app-stage").boundingBox();
      const box = await dialog.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(stage!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
      for (const frame of await dialog.locator(":scope > header, :scope > footer").all()) {
        const edge = await frame.boundingBox();
        expect(edge!.y).toBeGreaterThanOrEqual(stage!.y);
        expect(edge!.y + edge!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
      }
    };
    await assertBounded();
    if (surface === "inventory-route") {
      const scroll = page.locator(".inventory-carry-scroll");
      await scroll.evaluate((element) => { element.scrollTop = 500; });
      expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await assertBounded();
      await scroll.evaluate((element) => { element.scrollTop = 0; });
    }
    await page.locator(".developer-tools-panel").evaluate((element) => { (element as HTMLElement).style.visibility = "hidden"; });
    await page.screenshot({ path: testInfo.outputPath("desktop-bounded.png") });
    await page.locator(".developer-tools-panel").evaluate((element) => { (element as HTMLElement).style.visibility = "visible"; });
    await preview.selectOption("touch");
    await expect(page.locator("html")).toHaveAttribute("data-presentation", "touch");
    await expect(page.getByRole("navigation", { name: "Game commands" })).toHaveCount(0);
    if (surface === "chat") await expect(page.locator(".desktop-chat-window")).toHaveCount(0);
    else await expect(page.locator(".desktop-destination-shell")).toHaveCount(0);
    await preview.selectOption("desktop");
    if (surface !== "settings") await expect(page.getByRole("navigation", { name: "Game commands" })).toBeVisible();
    if (surface === "chat") await expect(dialog).toHaveAttribute("aria-modal", "false");
    await assertBounded();
    await preview.selectOption("auto");
    await expect(page.locator("html")).toHaveAttribute("data-presentation", "desktop");
    await preview.selectOption("touch");
    await view.unmount();
    await mount(<PresentationPreviewStory surface={surface} />);
    await expect(preview).toHaveValue("auto");
    await expect(page.locator("html")).toHaveAttribute("data-presentation", "desktop");
  });
}

for (const theme of ["light", "dark"]) test(`desktop command shell and floating messages: ${theme}`, async ({ page, mount }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate((value) => { document.documentElement.dataset.menuTheme = value; }, theme);
  const hud = await mount(<PhoneHudLayoutStory presentation="desktop" layoutMode="wide" safeAreaBottom={0} />);
  const commands = page.getByRole("navigation", { name: "Game commands" });
  await expect(commands).toBeVisible();
  await expect(commands.getByRole("button")).toHaveCount(11);
  await commands.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByTestId("inventory-opens")).toHaveText("1");
  const dock = await page.locator('.phone-bottom-bar[aria-label="Desktop command HUD"]').boundingBox();
  const bar = await commands.boundingBox();
  const resources = await page.locator(".phone-bottom-status").boundingBox();
  expect(bar!.y).toBeGreaterThan(resources!.y + resources!.height);
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(dock!.y + dock!.height + 1);
  await page.screenshot({ path: testInfo.outputPath("desktop-hud.png") });
  await hud.unmount();
  const menu = await mount(<PhoneHudLayoutStory presentation="desktop" layoutMode="wide" safeAreaBottom={0} menuView="menu" />);
  const menuBox = await page.getByRole("dialog", { name: "Game Menu", exact: true }).boundingBox();
  expect(menuBox!.x).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("desktop-menu.png") });
  await menu.unmount();
  await page.evaluate(() => { document.documentElement.dataset.uiProfile = "phone"; document.documentElement.dataset.presentation = "desktop"; });
  await mount(<FloatingMessagesStory />);
  const chat = page.getByRole("dialog", { name: "Private messages" });
  await expect(chat).toHaveAttribute("aria-modal", "false");
  await expect(page.locator(".mobile-chat-protection")).toHaveCount(0);
  const chatBox = await chat.boundingBox();
  expect(chatBox!.width).toBeLessThan(800);
  expect(chatBox!.height).toBeLessThan(700);
  await page.screenshot({ path: testInfo.outputPath("desktop-messages.png") });
  await page.getByRole("button", { name: "Minimize messages" }).click();
  await expect(chat).toHaveClass(/minimized/);
  await page.getByRole("button", { name: "Restore messages" }).click();
  await expect(chat).not.toHaveClass(/minimized/);
  await page.getByRole("button", { name: "Close messages" }).click();
  await expect(chat).toHaveCount(0);
});

test("wide touch tablet keeps the compact dock and full-screen menu", async ({ page, mount }, testInfo) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  const hud = await mount(<PhoneHudLayoutStory presentation="touch" layoutMode="wide" safeAreaBottom={0} />);
  await expect(page.getByRole("navigation", { name: "Game commands" })).toHaveCount(0);
  await expect(page.locator('.phone-bottom-bar[aria-label="Phone bottom HUD"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tablet-hud.png") });
  await hud.update(<PhoneHudLayoutStory presentation="touch" layoutMode="wide" safeAreaBottom={0} menuView="menu" />);
  const menu = await page.getByRole("dialog", { name: "Game Menu", exact: true }).boundingBox();
  const stage = await page.getByTestId("mobile-app-stage").boundingBox();
  expect(menu!.width).toBeCloseTo(stage!.width, 0);
  await page.screenshot({ path: testInfo.outputPath("tablet-menu.png") });
});
