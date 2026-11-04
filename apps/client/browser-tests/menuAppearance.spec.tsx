import { expect, test } from "@playwright/experimental-ct-react";
import { PhoneHudLayoutStory, MenuAppearanceStory, GameMenuLedgerStory, BuildCenterCompactStory } from "./PhoneHudLayoutStory.js";
import { ChatProtectionStory } from "./ChatProtectionStory.js";

test("Atlas Chats inactive room tabs inherit the active parchment palette", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<ChatProtectionStory />);
  await page.getByRole("button", { name: "Open General chat" }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.menuTheme = value; }, theme);
    const inactive = page.locator('.chat-room-tab-strip [role="tab"][aria-selected="false"]').first();
    await expect(inactive).toHaveCSS("background-color", theme === "light" ? "rgb(240, 228, 203)" : "rgb(52, 39, 31)");
  }
});

for (const width of [320, 390, 1280]) test(`appearance and dock at ${width}px`, async ({ page, mount }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  for (const theme of ["light", "dark"]) {
    const settings = await mount(<MenuAppearanceStory />);
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const select = page.getByRole("combobox", { name: "Menu theme" });
    await select.selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-menu-theme", theme);
    await expect(select).toHaveCSS("background-color", theme === "light" ? "rgb(231, 216, 185)" : "rgb(40, 31, 26)");
    await expect(select).toHaveCSS("color", theme === "light" ? "rgb(55, 41, 31)" : "rgb(238, 227, 202)");
    await expect(page.getByRole("tab", { name: "Support", exact: true })).toHaveCSS("background-color", theme === "light" ? "rgb(228, 209, 172)" : "rgb(67, 51, 41)");
    await page.screenshot({ path: testInfo.outputPath(`settings-${theme}.png`) });
    await settings.unmount();
    const restored = await mount(<MenuAppearanceStory />);
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Menu theme" })).toHaveValue(theme);
    await restored.unmount();
    const hud = await mount(<PhoneHudLayoutStory safeAreaBottom={34} inventoryUsed={8700} inventoryTotal={1000000} walletGold="12480" />);
    await expect(page.getByRole("button", { name: "Open Game Menu" })).toBeVisible();
    const targets = await page.locator(".phone-menu-trigger, .phone-bottom-economy").evaluateAll((nodes) => nodes.map((e) => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height, overflow: e.scrollWidth - e.clientWidth })));
    for (const target of targets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44); expect(target.overflow).toBeLessThanOrEqual(1); }
    await page.getByRole("button", { name: /^Open Inventory/ }).click();
    await expect(page.getByTestId("inventory-opens")).toHaveText("1");
    await page.screenshot({ path: testInfo.outputPath(`hud-${theme}.png`) });
    await hud.unmount();
    const root = await mount(<GameMenuLedgerStory />);
    await page.screenshot({ path: testInfo.outputPath(`root-${theme}.png`) });
    await root.unmount();
    const build = await mount(<BuildCenterCompactStory />);
    await page.screenshot({ path: testInfo.outputPath(`construction-${theme}.png`) });
    await build.unmount();
  }
});
