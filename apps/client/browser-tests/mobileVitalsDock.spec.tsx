import { expect, test } from "@playwright/experimental-ct-react";
import { PhoneHudLayoutStory } from "./PhoneHudLayoutStory.js";

for (const viewport of [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
  { width: 1024, height: 768 }
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`mobile vitals dock ${viewport.width}x${viewport.height} ${theme}`, async ({ page, mount }, testInfo) => {
      await page.setViewportSize(viewport);
      const hud = await mount(<PhoneHudLayoutStory
        safeAreaBottom={21}
        inventoryUsed={1_004_000}
        inventoryTotal={1_200_000}
        walletGold="125000"
        aggressiveRemainingMs={0}
      />);
      await page.evaluate(({ theme, landscape }) => {
        document.documentElement.dataset.menuTheme = theme;
        if (landscape) {
          document.documentElement.style.setProperty("--hud-safe-left", "44px");
          document.documentElement.style.setProperty("--hud-safe-right", "44px");
        }
      }, { theme, landscape: viewport.width > viewport.height });

      const footer = page.getByRole("contentinfo", { name: "Phone bottom HUD" });
      await expect(footer.locator(".phone-menu-trigger")).toHaveCount(1);
      await expect(footer.getByRole("button", { name: "Open Inventory", exact: true })).toHaveCount(0);
      await expect(footer.locator(".status-bar-phone-dock")).toHaveCount(3);
      await expect(footer.locator(".phone-economy-row")).toHaveCount(3);
      await expect(footer.getByText("At ease", { exact: true })).toBeVisible();
      await expect(footer.getByText("1004/1200 kg", { exact: true })).toBeVisible();

      const geometry = await footer.evaluate((element) => {
        const rect = (selector: string) => {
          const node = element.querySelector<HTMLElement>(selector)!;
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
        };
        return {
          height: element.getBoundingClientRect().height,
          left: rect(".phone-bottom-status"), menu: rect(".phone-menu-trigger"), right: rect(".phone-bottom-economy-compartment"),
          rows: Array.from(element.querySelectorAll(".status-bar-phone-dock"), (node) => node.getBoundingClientRect().y),
          progress: Array.from(element.querySelectorAll(".status-bar-phone-dock"), (node) => ({
            valueBottom: node.querySelector(".status-bar-compact-value")!.getBoundingClientRect().bottom,
            track: node.querySelector(".status-bar-track")!.getBoundingClientRect().toJSON(),
            bottom: node.getBoundingClientRect().bottom
          })),
          values: Array.from(element.querySelectorAll<HTMLElement>(".status-bar-compact-value, .status-bar-compact-maximum, .phone-economy-storage-value, .phone-economy-gold strong"), (node) => ({
            fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
            overflow: node.scrollWidth - node.clientWidth,
            box: node.getBoundingClientRect().toJSON(),
            panel: node.closest(".phone-bottom-status, .phone-bottom-economy-compartment")!.getBoundingClientRect().toJSON()
          }))
        };
      });
      expect(geometry.height).toBe(60 + 21);
      expect(geometry.left.right).toBeLessThan(geometry.menu.x);
      expect(geometry.menu.right).toBeLessThan(geometry.right.x);
      expect(geometry.left.y).toBe(geometry.right.y);
      expect(geometry.menu.width).toBeGreaterThanOrEqual(44);
      expect(geometry.menu.height).toBeGreaterThanOrEqual(44);
      expect(geometry.menu.height).toBe(48);
      expect(Math.abs(geometry.menu.x + geometry.menu.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
      expect(geometry.rows[0]).toBeLessThan(geometry.rows[1]!);
      expect(geometry.rows[1]).toBeLessThan(geometry.rows[2]!);
      for (const row of geometry.progress) {
        expect(row.track.height).toBe(2);
        expect(row.track.y).toBeGreaterThanOrEqual(row.valueBottom);
        expect(row.track.bottom).toBeLessThanOrEqual(row.bottom);
      }
      for (const value of geometry.values) {
        expect(value.fontSize).toBeGreaterThanOrEqual(12);
        expect(value.overflow).toBeLessThanOrEqual(1);
        expect(value.box.x).toBeGreaterThanOrEqual(value.panel.x);
        expect(value.box.right).toBeLessThanOrEqual(value.panel.right);
      }
      for (const utility of await page.locator(".legacy-controls-left, .legacy-controls-right-utility").all()) {
        const box = await utility.boundingBox();
        expect(box!.y + box!.height).toBeLessThan(geometry.left.y);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("dock.png") });

      await footer.getByRole("button", { name: /^Open Inventory\./ }).click();
      await expect(page.getByTestId("inventory-opens")).toHaveText("1");
      await expect(page.getByTestId("map-taps")).toHaveText("0");
      await page.mouse.click(geometry.left.right + 2, geometry.left.y + 10);
      await expect(page.getByTestId("map-taps")).toHaveText("1");

      await hud.update(<PhoneHudLayoutStory
        safeAreaBottom={21}
        inventoryUsed={1_204_000}
        inventoryTotal={1_200_000}
        aggressiveRemainingMs={6_200}
        healthCurrent={17}
        hungerCurrent={12}
      />);
      await expect(footer.getByRole("progressbar", { name: "Health", exact: true })).toHaveAttribute("aria-valuenow", "17");
      await expect(footer.getByRole("progressbar", { name: "Hunger", exact: true })).toHaveAttribute("aria-valuenow", "12");
      await expect(footer.locator(".phone-bottom-economy")).toHaveClass(/inventory-full/);
      await expect(footer.getByRole("status", { name: "Aggression 6.2s" })).toBeVisible();
      await expect(footer.locator(".phone-economy-storage-value")).toHaveText("1204/1200 kg");
      await expect(footer.getByRole("meter", { name: "Storage used" })).toHaveAttribute("aria-valuetext", "1,204 of 1,200 kg used");
      await page.screenshot({ path: testInfo.outputPath("dock-warning.png") });
    });
  }
}

for (const mode of ["browser", "pwa", "native"] as const) {
  test(`iPhone ${mode} paints the curved footer through the bottom safe area`, async ({ page, mount }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(<PhoneHudLayoutStory safeAreaBottom={34} iosStandalone={mode === "pwa"} aggressiveRemainingMs={0} />);
    if (mode === "native") await page.evaluate(() => { document.documentElement.dataset.nativeApp = "true"; });
    const geometry = await page.locator(".phone-bottom-bar").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const surface = getComputedStyle(element, "::before");
      return {
        left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height,
        surface: { content: surface.content, bottom: surface.bottom, inset: surface.left, background: surface.backgroundImage, curve: surface.borderTopLeftRadius },
        menuBottom: element.querySelector(".phone-menu-trigger")!.getBoundingClientRect().bottom,
        readoutBottom: element.querySelector(".phone-bottom-economy")!.getBoundingClientRect().bottom
      };
    });
    expect(geometry.left).toBe(0);
    expect(geometry.right).toBe(390);
    expect(geometry.bottom).toBe(844);
    expect(geometry.height).toBe(60 + 34);
    expect(geometry.surface.content).toBe('""');
    expect(geometry.surface.bottom).toBe("0px");
    expect(geometry.surface.inset).toBe("0px");
    expect(geometry.surface.background).not.toBe("none");
    expect(geometry.surface.curve).toBe("16px");
    expect(geometry.menuBottom).toBeLessThanOrEqual(810);
    expect(geometry.readoutBottom).toBeLessThanOrEqual(810);
    await page.screenshot({ path: testInfo.outputPath("iphone-safe-area.png") });
  });
}
