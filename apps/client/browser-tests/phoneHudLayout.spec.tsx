import { expect, test } from "@playwright/experimental-ct-react";

import {
  BuildCenterCompactStory,
  BuildCenterWideStory,
  GameMenuLedgerStory,
  PhoneHudLayoutStory
} from "./PhoneHudLayoutStory.js";

const gameMenuRootEntries = [
  { kind: "destination", id: "equipment" },
  { kind: "destination", id: "creature-book" },
  { kind: "destination", id: "messages" },
  { kind: "destination", id: "party" },
  { kind: "destination", id: "pet-chamber" },
  { kind: "destination", id: "progression" },
  { kind: "destination", id: "atlas" },
  { kind: "destination", id: "workshop" },
  { kind: "destination", id: "realm" }
];

for (const layout of [
  { width: 390, height: 844, mode: "compact" as const },
  { width: 1280, height: 900, mode: "wide" as const }
]) {
  test(`Build Center categories and City catalog fit ${layout.mode}`, async ({
    page,
    mount
  }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await mount(layout.mode === "compact"
      ? <BuildCenterCompactStory />
      : <BuildCenterWideStory />);
    await expect(page.getByRole("tab", { name: "Personal" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "City" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Kingdom" })).toBeVisible();
    await expect(page.locator(".game-app-card h3")).toHaveText(["Manor", "Territory Flag"]);
    await expect(page.getByText("Personal Shrine", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "City" }).click();
    await expect(page.locator(".game-app-card h3")).toHaveText([
      "Barracks",
      "City House",
      "City Market",
      "City Warehouse",
      "Demolition Factory",
      "Found City",
      "Lodge",
      "Mining Monument",
      "Warehouse Upgrade"
    ]);
    await expect(page.getByText("City Market", { exact: true })).toBeVisible();
    await expect(page.getByText("Mining Monument", { exact: true })).toBeVisible();
    await expect(page.getByText("Lodge", { exact: true })).toBeVisible();
    await expect(page.getByText("Barracks", { exact: true })).toBeVisible();
    await expect(page.getByText("Demolition Factory", { exact: true })).toBeVisible();
    await expect(page.getByText(/Armory|Powder Works|Siege Workshop|War Camp/i)).toHaveCount(0);
    await expect(page.getByText("Territory Flag", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Found Kingdom", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )).toBe(true);
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 375, height: 812 }
]) {
  test(`Game Menu root destinations fit and stay pinned at ${viewport.width}px`, async ({ page, mount }) => {
    await page.setViewportSize(viewport);
    await mount(<GameMenuLedgerStory />);

    const dialog = page.getByRole("dialog", { name: "Game Menu" });
    await expect(dialog).toBeVisible();
    const renderedEntries = await dialog.locator(".phone-menu-root .phone-menu-root-item").evaluateAll((elements) =>
      elements.map((element) => element.hasAttribute("data-mobile-menu-category")
        ? { kind: "category", id: element.getAttribute("data-mobile-menu-category") }
        : { kind: "destination", id: element.getAttribute("data-mobile-menu-id") })
    );
    expect(renderedEntries).toEqual(gameMenuRootEntries);
    await expect(dialog.locator(".phone-menu-root [data-mobile-menu-category]")).toHaveCount(0);
    await expect(dialog.locator(".phone-menu-root [data-mobile-menu-id]")).toHaveCount(gameMenuRootEntries.length);
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
      && document.body.scrollWidth <= document.body.clientWidth
    )).toBe(true);

    const before = await page.evaluate(() => {
      const read = (selector: string) => {
        const box = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      };
      const element = document.querySelector<HTMLElement>(".phone-menu-scroll")!;
      return {
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        header: read(".phone-menu-header"),
        footer: read(".phone-menu-footer")
      };
    });
    expect(before.scrollHeight - before.clientHeight).toBeLessThanOrEqual(1);

    await dialog.getByRole("button", { name: "Inventory" }).click();
    const after = await page.evaluate(() => {
      const read = (selector: string) => {
        const box = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      };
      return {
        header: read(".phone-menu-header"),
        footer: read(".phone-menu-footer")
      };
    });
    expect(Math.abs(after.header.top - before.header.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.header.bottom - before.header.bottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.footer.top - before.footer.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.footer.bottom - before.footer.bottom)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("inventory-opens")).toHaveText("1");
  });
}

for (const viewport of [
  { width: 320, height: 568, safeAreaBottom: 21 },
  { width: 360, height: 800, safeAreaBottom: 0 },
  { width: 375, height: 812, safeAreaBottom: 34 },
  { width: 390, height: 844, safeAreaBottom: 34 },
  { width: 393, height: 852, safeAreaBottom: 34 },
  { width: 430, height: 932, safeAreaBottom: 34 },
  { width: 568, height: 320, safeAreaBottom: 21 },
  { width: 882, height: 900, safeAreaBottom: 0 },
  { width: 1280, height: 900, safeAreaBottom: 0 }
]) {
  test(`${viewport.width}x${viewport.height} paints the ${viewport.safeAreaBottom}px bottom safe area and keeps state geometry stable`, async ({
    page,
    mount
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const component = await mount(<PhoneHudLayoutStory safeAreaBottom={viewport.safeAreaBottom} walletGold="1250" aggressiveRemainingMs={0} />);
    const sideInset = viewport.width === 568 ? 44 : 0;
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty("--hud-safe-left", `${inset}px`);
      document.documentElement.style.setProperty("--hud-safe-right", `${inset}px`);
    }, sideInset);

    const dock = page.locator(".phone-bottom-bar");
    const panels = dock.locator(
      ":scope > .phone-bottom-status, :scope > .phone-bottom-menu-compartment, :scope > .phone-bottom-economy-compartment"
    );
    const dockBox = await dock.boundingBox();
    expect(dockBox).not.toBeNull();
    expect(dockBox!.x).toBe(0);
    expect(dockBox!.width).toBe(viewport.width);
    const contentHeight = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--hud-bottom-content-height"))
    );
    const expectedContentHeight = viewport.height <= 520 && viewport.width > viewport.height ? 50.4 : 57.6;
    expect(contentHeight).toBeCloseTo(expectedContentHeight, 1);
    expect(Math.abs(dockBox!.height - (contentHeight + viewport.safeAreaBottom))).toBeLessThanOrEqual(1);
    expect(Math.abs(dockBox!.y + dockBox!.height - viewport.height)).toBeLessThanOrEqual(1);
    await expect(dock).toHaveCSS("background-color", "rgb(240, 228, 203)");
    await expect(dock).toHaveCSS("background-image", "none");
    await expect(dock).toHaveCSS("pointer-events", "none");
    await expect(panels).toHaveCount(3);

    const panelMetrics = await panels.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        bottom: box.bottom,
        top: box.top,
        height: box.height,
        left: box.left,
        right: box.right,
        pointerEvents: style.pointerEvents
      };
    }));
    for (const panel of panelMetrics) {
      expect(Math.abs(panel.bottom - viewport.height)).toBeLessThanOrEqual(1);
      expect(panel.top).toBeGreaterThanOrEqual(dockBox!.y);
      expect(panel.pointerEvents).toBe("none");
    }
    expect(panelMetrics[1]!.top).toBe(panelMetrics[0]!.top);
    expect(panelMetrics[1]!.height).toBeCloseTo(dockBox!.height, 0);
    expect(panelMetrics[0]!.left).toBe(sideInset);
    expect(panelMetrics[2]!.right).toBe(viewport.width - sideInset);

    const contentMetrics = await dock.locator(
      ".status-bar-phone-dock, .phone-economy-row, .phone-menu-trigger, .phone-menu-trigger > *"
    ).evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }));
    for (const content of contentMetrics) {
      expect(content.top).toBeGreaterThanOrEqual(dockBox!.y);
      expect(content.bottom).toBeLessThanOrEqual(dockBox!.y + contentHeight + 1);
    }
    await expect(dock.locator(".phone-menu-trigger")).toHaveCSS("pointer-events", "auto");
    await expect(dock.locator(".phone-bottom-economy")).toHaveCSS("pointer-events", "auto");
    const innerButtonMetrics = await dock.locator(".phone-menu-trigger, .phone-bottom-economy").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      })
    );
    expect(innerButtonMetrics[0]!.height).toBeCloseTo(contentHeight - 4, 0);
    expect(Math.abs(innerButtonMetrics[0]!.bottom - (dockBox!.y + contentHeight - 4))).toBeLessThanOrEqual(1);
    expect(innerButtonMetrics[1]!.height).toBeCloseTo(contentHeight, 0);
    expect(Math.abs(innerButtonMetrics[1]!.bottom - (dockBox!.y + contentHeight))).toBeLessThanOrEqual(1);
    const material = await dock.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return {
        background: style.backgroundImage,
        top: style.top,
        left: style.left,
        right: style.right,
        bottom: style.bottom,
        width: style.width,
        height: style.height,
        borderTopWidth: style.borderTopWidth,
        pointerEvents: style.pointerEvents
      };
    });
    expect(material.background).toContain("linear-gradient");
    expect(material.background).toContain("linear-gradient(165deg");
    expect(Number.parseFloat(material.width)).toBe(viewport.width);
    expect(Number.parseFloat(material.height) + Number.parseFloat(material.borderTopWidth)).toBeCloseTo(dockBox!.height, 0);
    expect(material.top).toBe("0px");
    expect(material.bottom).toBe("0px");
    expect(material.left).toBe("0px");
    expect(material.right).toBe("0px");
    expect(material.pointerEvents).toBe("none");

    const readRows = () => dock.locator(".status-bar-phone-dock, .phone-economy-row").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    const restingRows = await readRows();
    const ledgerPairMetrics = await dock.locator(".phone-economy-state").evaluateAll((rows) => rows.map((row) => {
      const icon = row.querySelector("svg")!.getBoundingClientRect();
      const value = row.querySelector("strong")!.getBoundingClientRect();
      return { gap: value.left - icon.right, valueLeft: value.left, centerOffset: (value.left + value.width / 2) - (icon.left + icon.width / 2), verticalGap: value.top - icon.bottom };
    }));
    for (const pair of ledgerPairMetrics) {
      if (viewport.width < 720) {
        expect(pair.gap).toBeGreaterThanOrEqual(4);
        expect(pair.gap).toBeLessThanOrEqual(6);
        expect(pair.valueLeft).toBe(ledgerPairMetrics[0]!.valueLeft);
      } else {
        expect(Math.abs(pair.centerOffset)).toBeLessThanOrEqual(1);
        expect(pair.verticalGap).toBeGreaterThanOrEqual(2);
      }
    }
    const storageMeter = dock.getByRole("meter", { name: "Storage used" });
    await expect(storageMeter).toHaveAttribute("aria-valuenow", "7");
    await expect(storageMeter).toHaveAttribute("aria-valuemax", "16");
    await expect(storageMeter.locator(".phone-economy-storage-fill")).toHaveAttribute("style", "width: 43.75%;");
    const storageBox = await storageMeter.boundingBox();
    const timerBox = await dock.locator(".phone-economy-state-track").boundingBox();
    if (viewport.width < 720) {
      expect(storageBox!.x).toBeLessThan(timerBox!.x);
      expect(storageBox!.width).toBeGreaterThan(timerBox!.width);
    } else {
      expect(Math.abs(storageBox!.width - timerBox!.width)).toBeLessThanOrEqual(1);
    }
    for (let row = 0; row < 3; row += 1) {
      if (viewport.width < 720) {
        expect(restingRows[row]!.y).toBe(restingRows[row + 3]!.y);
      } else {
        expect(restingRows[row + 3]!.y).toBe(restingRows[3]!.y);
        expect(restingRows[row + 3]!.height).toBe(restingRows[3]!.height);
      }
      expect(restingRows[row]!.height).toBeGreaterThanOrEqual(12);
    }
    await expect(dock.locator(".phone-player-state-glyph-none")).toHaveCSS("color", "rgb(55, 41, 31)");
    await page.screenshot({ path: testInfo.outputPath("neutral.png") });
    for (const [state, aggression, protection] of [["aggression", 8_000, 0], ["protection", 0, 9_400]] as const) {
      await component.update(<PhoneHudLayoutStory safeAreaBottom={viewport.safeAreaBottom} walletGold="1250" aggressiveRemainingMs={aggression} flagArrivalProtectionRemainingMs={protection} />);
      expect(await readRows()).toEqual(restingRows);
      await expect(dock.locator(".phone-economy-state")).toHaveAttribute("data-player-state", state);
      const track = dock.locator(".phone-economy-state-track");
      if (state === "aggression") {
        await expect(track).toHaveAttribute("aria-valuenow", "8000");
        await expect(track).toHaveAttribute("aria-valuemax", "10000");
      } else {
        await expect(track).toHaveAttribute("role", "progressbar");
        await expect(track).toHaveAttribute("aria-valuenow", "9400");
        await expect(track).toHaveAttribute("aria-valuemax", "10000");
        await expect(track).toHaveCSS("height", "8px");
      }
      await page.screenshot({ path: testInfo.outputPath(`${state}.png`) });
    }

    await component.update(<PhoneHudLayoutStory safeAreaBottom={viewport.safeAreaBottom} walletGold="1250" aggressiveRemainingMs={0} flagArrivalProtectionRemainingMs={2_500} />);
    const protectionFill = dock.locator(".phone-economy-state-fill");
    await expect(protectionFill).toHaveAttribute("style", "width: 25%;");
    await expect.poll(async () => {
      const fill = await protectionFill.boundingBox();
      const track = await dock.locator(".phone-economy-state-track").boundingBox();
      return Math.round(fill!.width / (track!.width - 2) * 100);
    }).toBe(25);
    expect(await readRows()).toEqual(restingRows);
    await page.screenshot({ path: testInfo.outputPath("protection-drained.png") });

    if (viewport.safeAreaBottom > 0) {
      const safePoint = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return {
          testId: element?.getAttribute("data-testid"),
          className: element?.getAttribute("class")
        };
      }, { x: Math.floor(viewport.width / 2), y: viewport.height - 3 });
      expect(safePoint.testId).toBe("map-background");
      await page.mouse.click(Math.floor(viewport.width / 2), viewport.height - 3);
      await expect(page.getByTestId("map-taps")).toHaveText("1");
    }
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("bottom dock stays off loading and full-screen surfaces, then returns for gameplay overlays", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<PhoneHudLayoutStory gameplayReady={false} />);
  await expect(page.locator(".phone-bottom-bar")).toHaveCount(0);

  await component.update(<PhoneHudLayoutStory menuView="menu" gameplayReady />);
  await expect(page.locator(".phone-bottom-bar")).toHaveCount(0);

  await component.update(<PhoneHudLayoutStory gameplayReady hideBottomDock />);
  await expect(page.locator(".phone-bottom-bar")).toHaveCount(0);

  await component.update(<PhoneHudLayoutStory gameplayReady />);
  await expect(page.locator(".phone-bottom-bar")).toBeVisible();
});

test("installed iOS PWA keeps one 61.2px dock band flush with the viewport bottom", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<PhoneHudLayoutStory safeAreaBottom={34} iosStandalone />);

  const geometry = await page.locator(".phone-bottom-bar").evaluate((element) => {
    const dock = element.getBoundingClientRect();
    const read = (selector: string) => {
      const child = element.querySelector<HTMLElement>(selector);
      if (!child) throw new Error(`Missing dock child: ${selector}`);
      const box = child.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        left: box.left,
        right: box.right,
        pointerEvents: getComputedStyle(child).pointerEvents
      };
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const point = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return {
        className: hit?.getAttribute("class"),
        testId: hit?.getAttribute("data-testid")
      };
    };
    return {
      dock: { top: dock.top, bottom: dock.bottom, height: dock.height },
      contentHeight: rootStyle.getPropertyValue("--hud-bottom-content-height").trim(),
      clearance: rootStyle.getPropertyValue("--hud-bottom-home-clearance").trim(),
      rows: getComputedStyle(element).gridTemplateRows,
      parentClass: element.parentElement?.getAttribute("class"),
      inContainedStage: element.closest(".mobile-app-stage") !== null,
      status: read(".phone-bottom-status"),
      menuShell: read(".phone-bottom-menu-compartment"),
      economyShell: read(".phone-bottom-economy-compartment"),
      menu: read(".phone-menu-trigger"),
      economy: read(".phone-bottom-economy"),
      passiveLeftBottom: point(5, window.innerHeight - 1),
      menuBottom: point(Math.floor(window.innerWidth / 2), window.innerHeight - 1),
      economyBottom: point(window.innerWidth - 5, window.innerHeight - 1),
      economyMid: point(330, window.innerHeight - 1)
    };
  });

  expect(geometry.dock.top).toBeCloseTo(782.8, 0);
  expect(geometry.dock.bottom).toBe(844);
  expect(geometry.dock.height).toBeCloseTo(61.2, 0);
  expect(geometry.contentHeight).toBe("61.2px");
  expect(geometry.clearance).toBe("0px");
  expect(Number.parseFloat(geometry.rows)).toBeCloseTo(61.2, 1);
  expect(geometry.inContainedStage).toBe(false);
  expect(geometry.parentClass).toBeNull();
  expect(geometry.status.bottom).toBe(844);
  expect(geometry.menuShell.top).toBeCloseTo(782.8, 0);
  expect(geometry.menuShell.bottom).toBe(844);
  expect(geometry.menuShell.height).toBeCloseTo(61.2, 0);
  expect(geometry.menuShell.pointerEvents).toBe("none");
  expect(geometry.economyShell.top).toBeCloseTo(782.8, 0);
  expect(geometry.economyShell.bottom).toBe(844);
  expect(geometry.economyShell.height).toBeCloseTo(61.2, 0);
  expect(geometry.economyShell.pointerEvents).toBe("none");
  expect(geometry.menu.top).toBeCloseTo(782.8, 0);
  expect(geometry.menu.bottom).toBe(840);
  expect(geometry.menu.height).toBeCloseTo(57.2, 0);
  expect(geometry.menu.pointerEvents).toBe("auto");
  expect(geometry.economy.top).toBeCloseTo(782.8, 0);
  expect(geometry.economy.bottom).toBe(844);
  expect(geometry.economy.height).toBeCloseTo(61.2, 0);
  expect(geometry.economy.pointerEvents).toBe("auto");
  expect(geometry.dock).not.toEqual(expect.objectContaining({ top: 742, bottom: 810, height: 102 }));
  expect(geometry.dock.top).not.toBe(742);
  expect(geometry.dock.bottom).not.toBe(810);
  expect(geometry.dock.height).not.toBe(102);
  expect(geometry.passiveLeftBottom).toEqual({ className: "phone-hud-layout-map", testId: "map-background" });
  expect(geometry.economyBottom).toEqual({ className: "phone-hud-layout-map", testId: "map-background" });
  expect(geometry.menuBottom).toEqual({ className: "phone-hud-layout-map", testId: "map-background" });
  expect(geometry.economyMid.className).toContain("phone-bottom-economy");
});

for (const viewport of [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "tablet portrait", width: 768, height: 1024 },
  { name: "tablet landscape", width: 1024, height: 768 }
]) {
  test(`wide ${viewport.name} keeps the dock inside the centered playable stage`, async ({ page, mount }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mount(<PhoneHudLayoutStory layoutMode="wide" safeAreaBottom={0} />);

    const geometry = await page.locator(".phone-bottom-bar").evaluate((dock) => {
      const stage = dock.closest<HTMLElement>(".mobile-app-stage");
      if (!stage) throw new Error("wide HUD dock is not inside the playable stage");
      const viewportRect = {
        width: window.innerWidth,
        height: window.innerHeight
      };
      const stageRect = stage.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      return {
        stage: {
          x: stageRect.x,
          y: stageRect.y,
          right: stageRect.right,
          bottom: stageRect.bottom,
          width: stageRect.width,
          height: stageRect.height
        },
        dock: {
          x: dockRect.x,
          y: dockRect.y,
          right: dockRect.right,
          bottom: dockRect.bottom,
          width: dockRect.width,
          height: dockRect.height
        },
        viewport: viewportRect,
        parentClass: dock.parentElement?.className ?? null
      };
    });

    expect(geometry.parentClass).toBe("mobile-app-stage");
    expect(geometry.stage.x).toBeGreaterThanOrEqual(0);
    expect(geometry.stage.y).toBeGreaterThanOrEqual(0);
    expect(geometry.stage.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.stage.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(Math.abs(geometry.stage.x - (geometry.viewport.width - geometry.stage.width) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.stage.y - (geometry.viewport.height - geometry.stage.height) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.dock.x - geometry.stage.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.dock.right - geometry.stage.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.dock.bottom - geometry.stage.bottom)).toBeLessThanOrEqual(1);
    expect(geometry.dock.width).toBeCloseTo(geometry.stage.width, 0);
  });
}

test("installed iOS PWA insets only the bottom outer-corner resource content", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<PhoneHudLayoutStory safeAreaBottom={34} iosStandalone aggressiveRemainingMs={0} />);

  const metrics = await page.locator(".phone-bottom-bar").evaluate((dock) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const status = dock.querySelector<HTMLElement>(".phone-bottom-status")!;
    const economy = dock.querySelector<HTMLElement>(".phone-bottom-economy")!;
    const hunger = dock.querySelector<HTMLElement>(".status-bar-hunger")!;
    const gold = dock.querySelector<HTMLElement>(".phone-economy-gold")!;
    const rows = Array.from(dock.querySelectorAll(".status-bar-phone-dock"), (row) => row.className);
    const economyRows = Array.from(dock.querySelectorAll(".phone-economy-row"), (row) => row.className);
    return {
      normalPadding: rootStyle.getPropertyValue("--ios-dock-normal-side-padding").trim(),
      cornerInset: rootStyle.getPropertyValue("--ios-dock-corner-content-inset").trim(),
      hungerExtraInset: rootStyle.getPropertyValue("--ios-dock-hunger-extra-inset").trim(),
      storageExtraInset: rootStyle.getPropertyValue("--ios-dock-storage-extra-inset").trim(),
      statusPaddingLeft: getComputedStyle(status).paddingLeft,
      economyPaddingRight: getComputedStyle(economy).paddingRight,
      hungerPaddingLeft: getComputedStyle(hunger).paddingLeft,
      goldPaddingRight: getComputedStyle(gold).paddingRight,
      rows,
      economyRows,
      dock: (() => {
        const box = dock.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      })()
    };
  });

  expect(metrics.normalPadding).toBe("8px");
  expect(metrics.cornerInset).toBe("20px");
  expect(metrics.hungerExtraInset).toBe("6px");
  expect(metrics.storageExtraInset).toBe("4px");
  expect(metrics.statusPaddingLeft).toBe("8px");
  expect(metrics.economyPaddingRight).toBe("8px");
  expect(metrics.hungerPaddingLeft).toBe("18px");
  expect(metrics.goldPaddingRight).toBe("12px");
  expect(metrics.rows).toEqual([
    "status-bar status-bar-phone-dock status-bar-health",
    "status-bar status-bar-phone-dock status-bar-experience status-bar-thin",
    "status-bar status-bar-phone-dock status-bar-hunger"
  ]);
  expect(metrics.economyRows).toEqual([
    "phone-economy-row phone-economy-state phone-economy-state-none",
    "phone-economy-row phone-economy-storage",
    "phone-economy-row phone-economy-gold"
  ]);
  expect(metrics.dock.top).toBeCloseTo(782.8, 0);
  expect(metrics.dock.bottom).toBe(844);
  expect(metrics.dock.height).toBeCloseTo(61.2, 0);
});

test("installed iOS PWA keeps inline resource values readable inside safe storage bounds", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(
    <PhoneHudLayoutStory
      safeAreaBottom={34}
      iosStandalone
      walletGold="1250"
      inventoryUsed={15999}
      inventoryTotal={16000}
      aggressiveRemainingMs={0}
    />
  );

  const dock = page.locator(".phone-bottom-bar");
  await expect(dock.locator(".status-bar-health .status-bar-track > .status-bar-compact-value")).toHaveText("72/100");
  await expect(dock.locator(".status-bar-experience .status-bar-track > .status-bar-compact-value")).toHaveText("500K/500K");
  await expect(dock.locator(".status-bar-hunger .status-bar-track > .status-bar-compact-value")).toHaveText("1,200/2,000");
  await expect(dock.locator(".phone-economy-storage-value")).toHaveText("16 / 16 kg");
  await expect(dock.locator(".phone-economy-storage .phone-economy-row-icon")).toHaveCSS("color", "rgb(55, 41, 31)");

  const bounds = await dock.evaluate((element) => {
    const read = (selector: string) => {
      const value = element.querySelector<HTMLElement>(selector);
      if (!value) throw new Error(`Missing inline value: ${selector}`);
      const box = value.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    };
    const storageTrack = read(".phone-economy-storage-track");
    const storageValue = read(".phone-economy-storage-value");
    const statusPanel = element.querySelector<HTMLElement>(".phone-bottom-status")!.getBoundingClientRect();
    const menuPanel = element.querySelector<HTMLElement>(".phone-bottom-menu-compartment")!.getBoundingClientRect();
    const statusTracks = Array.from(element.querySelectorAll<HTMLElement>(".phone-bottom-status .status-bar-track"), (track) => {
      const value = track.querySelector<HTMLElement>(".status-bar-compact-value");
      const box = track.getBoundingClientRect();
      const valueStyle = value ? getComputedStyle(value) : null;
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        cssHeight: getComputedStyle(track).height,
        valueColor: valueStyle?.color ?? "",
        valueScrollWidth: value?.scrollWidth ?? 0,
        valueClientWidth: value?.clientWidth ?? 0,
        fontFamily: valueStyle?.fontFamily ?? "",
        fontSize: valueStyle?.fontSize ?? "",
        fontWeight: valueStyle?.fontWeight ?? "",
        lineHeight: valueStyle?.lineHeight ?? "",
        textShadow: valueStyle?.textShadow ?? ""
      };
    });
    const storageTrackElement = element.querySelector<HTMLElement>(".phone-economy-storage-track")!;
    const storageValueElement = element.querySelector<HTMLElement>(".phone-economy-storage-value")!;
    const storageValueStyle = getComputedStyle(storageValueElement);
    const goldValueStyle = getComputedStyle(element.querySelector<HTMLElement>(".phone-economy-gold strong")!);
    const rightIcons = Array.from(element.querySelectorAll<HTMLElement>(
      ".phone-player-state-glyph, .phone-economy-row-icon"
    ), (icon) => {
      const box = icon.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height };
    });
    const statusValues = Array.from(element.querySelectorAll<HTMLElement>(".phone-bottom-status .status-bar-compact-value"), (value) => {
      const track = value.parentElement!.getBoundingClientRect();
      const box = value.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, trackLeft: track.left, trackRight: track.right };
    });
    return {
      storageTrack,
      storageValue,
      statusValues,
      statusTracks,
      leftPanelRight: statusPanel.right,
      menuPanelLeft: menuPanel.left,
      rightIcons,
      storageTrackHeight: getComputedStyle(storageTrackElement).height,
      storageValueScrollWidth: storageValueElement.scrollWidth,
      storageValueClientWidth: storageValueElement.clientWidth,
      storageFont: {
        family: storageValueStyle.fontFamily,
        size: storageValueStyle.fontSize,
        weight: storageValueStyle.fontWeight,
        lineHeight: storageValueStyle.lineHeight,
        textShadow: storageValueStyle.textShadow
      },
      goldFont: {
        family: goldValueStyle.fontFamily,
        size: goldValueStyle.fontSize,
        weight: goldValueStyle.fontWeight,
        lineHeight: goldValueStyle.lineHeight,
        textShadow: goldValueStyle.textShadow
      },
      viewportRight: window.innerWidth,
      storageTrackBackground: getComputedStyle(storageTrackElement).backgroundColor,
      storageRightPadding: getComputedStyle(element.querySelector<HTMLElement>(".phone-economy-storage")!).paddingRight
    };
  });
  expect(bounds.storageRightPadding).toBe("16px");
  expect(bounds.storageTrack.right).toBeLessThanOrEqual(366);
  expect(bounds.storageValue.left).toBeGreaterThanOrEqual(bounds.storageTrack.left);
  expect(bounds.storageValue.right).toBeLessThanOrEqual(bounds.storageTrack.right);
  expect(bounds.storageTrackHeight).toBe("12px");
  expect(bounds.storageTrackBackground).toBe("rgb(89, 70, 49)");
  expect(bounds.storageValueScrollWidth).toBeLessThanOrEqual(bounds.storageValueClientWidth);
  expect(bounds.statusTracks).toHaveLength(3);
  expect(bounds.statusTracks.map((track) => track.cssHeight)).toEqual(["12px", "10px", "10px"]);
  expect(bounds.statusTracks.map((track) => track.valueColor)).toEqual(["rgb(255, 255, 255)", "rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
  expect(bounds.statusTracks.map((track) => track.right)).toEqual([
    bounds.statusTracks[0]!.right,
    bounds.statusTracks[0]!.right,
    bounds.statusTracks[0]!.right
  ]);
  for (const track of bounds.statusTracks) {
    expect(track.right).toBeLessThanOrEqual(bounds.menuPanelLeft);
    expect(track.right).toBeGreaterThanOrEqual(bounds.leftPanelRight - 12);
    expect(track.valueScrollWidth).toBeLessThanOrEqual(track.valueClientWidth);
  }
  expect(bounds.statusTracks[0]).toMatchObject({ fontFamily: bounds.goldFont.family, fontSize: "12px", fontWeight: "800" });
  expect(bounds.statusTracks[1]).toMatchObject({ fontFamily: bounds.goldFont.family, fontSize: "10px", fontWeight: "500" });
  expect(bounds.statusTracks[2]).toMatchObject({ fontFamily: bounds.goldFont.family, fontSize: "10px", fontWeight: "600" });
  expect(Math.max(...bounds.rightIcons.map((icon) => icon.left)) - Math.min(...bounds.rightIcons.map((icon) => icon.left))).toBeLessThanOrEqual(1);
  for (const icon of bounds.rightIcons) {
    expect(icon.width).toBe(14);
    expect(icon.height).toBe(14);
  }
  expect(bounds.storageFont).toEqual(bounds.goldFont);
  for (const value of bounds.statusValues) {
    expect(value.left).toBeGreaterThanOrEqual(value.trackLeft);
    expect(value.right).toBeLessThanOrEqual(value.trackRight);
  }

  await component.update(
    <PhoneHudLayoutStory
      safeAreaBottom={34}
      iosStandalone
      walletGold="1250"
      inventoryUsed={16000}
      inventoryTotal={16000}
      aggressiveRemainingMs={0}
    />
  );
  await expect(dock.locator(".phone-economy-storage-value")).toHaveText("16 / 16 kg");
  await expect(dock.locator(".phone-economy-storage-fill")).toHaveAttribute("style", "width: 100%;");
  const fullInlineValue = await dock.locator(".phone-economy-storage-value").evaluate((value) => ({
    scrollWidth: value.scrollWidth,
    clientWidth: value.clientWidth
  }));
  expect(fullInlineValue.scrollWidth).toBeLessThanOrEqual(fullInlineValue.clientWidth);

  await component.update(
    <PhoneHudLayoutStory
      safeAreaBottom={34}
      iosStandalone
      walletGold="1250"
      inventoryUsed={0}
      inventoryTotal={0}
      aggressiveRemainingMs={0}
    />
  );
  await expect(dock.locator(".phone-economy-storage-value")).toHaveText("0 / 0 kg");
  await expect(dock.locator(".phone-economy-storage-track")).toHaveAttribute("aria-hidden", "true");
  const emptyInlineValue = await dock.locator(".phone-economy-storage-value").evaluate((value) => ({
    scrollWidth: value.scrollWidth,
    clientWidth: value.clientWidth
  }));
  expect(emptyInlineValue.scrollWidth).toBeLessThanOrEqual(emptyInlineValue.clientWidth);

  await component.update(
    <PhoneHudLayoutStory
      safeAreaBottom={34}
      iosStandalone
      walletGold="1250"
      inventoryUsed={1_234_567_500}
      inventoryTotal={2_000_000_000}
      aggressiveRemainingMs={0}
    />
  );
  await expect(dock.locator(".phone-economy-storage-value")).toHaveText("1M / 2M kg");
  const largeInlineValue = await dock.locator(".phone-economy-storage-value").evaluate((value) => ({
    scrollWidth: value.scrollWidth,
    clientWidth: value.clientWidth
  }));
  await expect(dock.locator(".phone-economy-storage-value")).toHaveAttribute("title", "1,234,567.5 / 2,000,000 kg");
  expect(largeInlineValue.scrollWidth).toBeLessThanOrEqual(largeInlineValue.clientWidth);
  const largeValueBounds = await dock.locator(".phone-economy-storage-value").boundingBox();
  const largeTrackBounds = await dock.locator(".phone-economy-storage-track").boundingBox();
  expect(largeValueBounds).not.toBeNull();
  expect(largeTrackBounds).not.toBeNull();
  expect(largeValueBounds!.x).toBeGreaterThanOrEqual(largeTrackBounds!.x);
  expect(largeValueBounds!.x + largeValueBounds!.width).toBeLessThanOrEqual(largeTrackBounds!.x + largeTrackBounds!.width);
  expect(largeTrackBounds!.x + largeTrackBounds!.width).toBeLessThanOrEqual(366);
});

test("generic mobile keeps normal content padding without the iOS corner inset", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<PhoneHudLayoutStory safeAreaBottom={34} />);

  const metrics = await page.locator(".phone-bottom-bar").evaluate((dock) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const hunger = dock.querySelector<HTMLElement>(".status-bar-hunger")!;
    const gold = dock.querySelector<HTMLElement>(".phone-economy-gold")!;
    return {
      normalPadding: rootStyle.getPropertyValue("--ios-dock-normal-side-padding").trim(),
      cornerInset: rootStyle.getPropertyValue("--ios-dock-corner-content-inset").trim(),
      hungerPaddingLeft: getComputedStyle(hunger).paddingLeft,
      goldPaddingRight: getComputedStyle(gold).paddingRight
    };
  });

  expect(metrics.normalPadding).toBe("");
  expect(metrics.cornerInset).toBe("");
  expect(metrics.hungerPaddingLeft).toBe("0px");
  expect(metrics.goldPaddingRight).toBe("0px");
});

test("side quick-slot toggles sit above edge-hugging stacks and reverse direction", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<PhoneHudLayoutStory safeAreaBottom={34} quickSlots />);

  const leftRail = page.locator(".phone-quick-slot-rail-left");
  const rightRail = page.locator(".phone-quick-slot-rail-right");
  const leftStack = leftRail.locator(".phone-quick-slot-stack");
  const rightStack = rightRail.locator(".phone-quick-slot-stack");
  const leftToggle = leftRail.locator(".phone-quick-slot-toggle");
  const rightToggle = rightRail.locator(".phone-quick-slot-toggle");
  const readBox = (locator: ReturnType<typeof page.locator>) => locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  });

  const [leftStackBox, rightStackBox, leftToggleBox, rightToggleBox] = await Promise.all([
    readBox(leftStack),
    readBox(rightStack),
    readBox(leftToggle),
    readBox(rightToggle)
  ]);
  expect(Math.abs(leftToggleBox.bottom - leftStackBox.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(rightToggleBox.bottom - rightStackBox.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftToggleBox.top - rightToggleBox.top)).toBeLessThanOrEqual(1);
  expect(leftToggleBox.left).toBeLessThanOrEqual(1);
  expect(rightToggleBox.right).toBeGreaterThanOrEqual(389);
  expect(await leftToggle.locator("path").getAttribute("d")).toBe("m9 4 6 8-6 8");
  expect(await rightToggle.locator("path").getAttribute("d")).toBe("m15 4-6 8 6 8");

  await leftToggle.click();
  await expect(leftToggle).toHaveAttribute("aria-expanded", "true");
  await expect(leftStack).toHaveCSS("visibility", "visible");
  await expect.poll(() => leftStack.evaluate((element) => Number.parseFloat(getComputedStyle(element).maxHeight))).toBeGreaterThan(280);
  const [openLeftStackBox, openLeftToggleBox] = await Promise.all([
    readBox(leftStack),
    readBox(leftToggle)
  ]);
  expect(Math.abs(openLeftToggleBox.bottom - openLeftStackBox.top)).toBeLessThanOrEqual(1);
  const quickSlotVisibleWidth = await page.evaluate(() => Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--hud-quick-slot-visible")
  ));
  expect(Math.abs((openLeftToggleBox.left - openLeftStackBox.left) - quickSlotVisibleWidth)).toBeLessThanOrEqual(1);
  expect(await leftToggle.locator("path").getAttribute("d")).toBe("m15 4-6 8 6 8");
  const slotVisual = await leftRail.locator('[data-quick-slot-index="1"]').evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { width: style.width, height: style.height, left: style.left };
  });
  expect(slotVisual).toEqual({ width: `${quickSlotVisibleWidth}px`, height: "68px", left: "0px" });
  const rightSlotVisual = await rightRail.locator('[data-quick-slot-index="1"]').evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { width: style.width, height: style.height, right: style.right };
  });
  expect(rightSlotVisual).toEqual({ width: `${quickSlotVisibleWidth}px`, height: "68px", right: "0px" });
  const slotBoxes = await leftRail.locator(".phone-quick-slot").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    })
  );
  for (const [index, box] of slotBoxes.entries()) {
    expect(box.bottom - box.top).toBeGreaterThanOrEqual(67);
    const next = slotBoxes[index + 1];
    if (next) expect(next.top).toBeGreaterThanOrEqual(box.bottom);
  }
  const secondSlot = leftRail.locator('[data-quick-slot-index="2"]');
  const secondSlotBox = await readBox(secondSlot);
  await page.mouse.click(
    (secondSlotBox.left + secondSlotBox.right) / 2,
    (secondSlotBox.top + secondSlotBox.bottom) / 2
  );
  await expect(leftToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("map-taps")).toHaveText("0");

  await rightToggle.click();
  await expect(rightToggle).toHaveAttribute("aria-expanded", "true");
  await expect(rightStack).toHaveCSS("visibility", "visible");
  const [openRightStackBox, openRightToggleBox] = await Promise.all([
    readBox(rightStack),
    readBox(rightToggle)
  ]);
  expect(Math.abs(openRightToggleBox.bottom - openRightStackBox.top)).toBeLessThanOrEqual(1);
  expect(Math.abs((openRightStackBox.right - openRightToggleBox.right) - quickSlotVisibleWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(openRightToggleBox.top - openLeftToggleBox.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(openRightStackBox.top - openLeftStackBox.top)).toBeLessThanOrEqual(1);
  expect(await rightToggle.locator("path").getAttribute("d")).toBe("m9 4 6 8-6 8");
  expect(await page.evaluate(() =>
    document.body.scrollWidth <= window.innerWidth && document.body.scrollHeight <= window.innerHeight
  )).toBe(true);
});

test("side quick-slot stacks stay above the bottom dock in landscape", async ({ page, mount }) => {
  await page.setViewportSize({ width: 844, height: 560 });
  await mount(<PhoneHudLayoutStory safeAreaBottom={34} quickSlots />);
  await page.evaluate(() => {
    document.documentElement.dataset.orientation = "landscape";
  });

  const leftRail = page.locator(".phone-quick-slot-rail-left");
  const leftStack = leftRail.locator(".phone-quick-slot-stack");
  const leftToggle = leftRail.locator(".phone-quick-slot-toggle");
  await leftToggle.click();
  await expect(leftStack).toHaveCSS("visibility", "visible");
  const readVerticalBox = (locator: ReturnType<typeof page.locator>) => locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  });
  const stackBox = await readVerticalBox(leftStack);
  const toggleBox = await readVerticalBox(leftToggle);
  const dockBox = await readVerticalBox(page.locator(".phone-bottom-bar"));
  expect(stackBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  expect(stackBox.bottom).toBeLessThanOrEqual(dockBox.top);
  expect(toggleBox.top).toBeGreaterThanOrEqual(40);
  expect(toggleBox.bottom).toBeLessThanOrEqual(stackBox.top);
});

test("status tracks stay identical while the ledger shows Status, Storage, and Gold", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<PhoneHudLayoutStory safeAreaBottom={34} inventoryUsed={7000} inventoryTotal={16000} />);
  const dock = page.locator(".phone-bottom-bar");
  const tracks = page.locator(".phone-bottom-status .status-bar-track");
  await expect(tracks).toHaveCount(3);
  const trackBoxes = await tracks.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON())
  );
  for (const box of trackBoxes.slice(1)) {
    expect(Math.abs(box.left - trackBoxes[0]!.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.right - trackBoxes[0]!.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - trackBoxes[0]!.width)).toBeLessThanOrEqual(1);
  }
  const leftRows = dock.locator(".status-bar-phone-dock");
  const leftOrder = await leftRows.evaluateAll((rows) => rows.map((row) => row.classList.contains("status-bar-health")
    ? "HP"
    : row.classList.contains("status-bar-experience") ? "EXP" : "Hunger"));
  expect(leftOrder).toEqual(["HP", "EXP", "Hunger"]);

  const economy = page.locator(".phone-bottom-economy");
  const rightOrder = await economy.locator(":scope > .phone-economy-row").evaluateAll((rows) => rows.map((row) => row.classList.contains("phone-economy-state")
    ? "Status"
    : row.classList.contains("phone-economy-storage") ? "Storage" : "Gold"));
  expect(rightOrder).toEqual(["Status", "Storage", "Gold"]);
  await expect(economy).toHaveAttribute("type", "button");
  await expect(economy).toHaveAttribute(
    "aria-label",
    "Open Inventory. Aggression 6.2s. Carry weight 7 of 16 kg. Gold 9,999,999,999,999,999,999."
  );
  await expect(economy.locator(".phone-economy-state-value")).toHaveText("6.2s");
  await expect(economy.locator(".phone-economy-state-value")).toHaveCSS("color", "rgb(55, 41, 31)");
  await expect(economy.locator(".phone-economy-storage-value")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(economy.locator(".phone-economy-gold > strong")).toHaveCSS("color", "rgb(55, 41, 31)");
  await expect(economy.locator("button")).toHaveCount(0);
  await expect(page.locator(".status-bar-experience .aggressive-timer")).toHaveCount(0);
  expect(await economy.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const economyTargets = [
    economy.getByText("7 / 16 kg"),
    economy.locator(".phone-economy-gold"),
    economy.getByText("6.2s"),
    economy
  ];
  for (const [index, target] of economyTargets.entries()) {
    await target.click();
    const expectedCount = String(index + 1);
    await expect(page.getByTestId("inventory-opens")).toHaveText(expectedCount);
  }
  await economy.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("inventory-opens")).toHaveText("5");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("inventory-opens")).toHaveText("6");

  await component.update(
    <PhoneHudLayoutStory
      safeAreaBottom={34}
      walletGold="9999999999999999999"
      inventoryUsed={7000}
      inventoryTotal={16000}
      aggressiveRemainingMs={0}
    />
  );
  await expect(economy).toHaveAttribute(
    "aria-label",
    "Open Inventory. No active player state. Carry weight 7 of 16 kg. Gold 9,999,999,999,999,999,999."
  );
  await expect(economy.locator(".phone-economy-gold strong")).toHaveText("9E");
  await expect(economy.locator(".phone-economy-gold strong")).toHaveAttribute("title", "9,999,999,999,999,999,999");
  await expect(economy.locator(".phone-economy-state-value")).toHaveCSS("visibility", "hidden");
  const updatedTrackBoxes = await tracks.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON())
  );
  expect(Math.abs(updatedTrackBoxes[2]!.width - trackBoxes[2]!.width)).toBeLessThanOrEqual(1);

  const storageTrack = economy.locator(".phone-economy-storage-track");
  const capacityBox = await storageTrack.boundingBox();
  await component.update(<PhoneHudLayoutStory safeAreaBottom={34} aggressiveRemainingMs={0} inventoryUsed={16000} inventoryTotal={16000} />);
  await expect(economy).toHaveClass(/inventory-full/);
  await expect(economy.locator(".phone-economy-storage-fill")).toHaveAttribute("style", "width: 100%;");
  await expect(storageTrack).toHaveAttribute("aria-valuetext", "16 of 16 kg used");
  expect(await storageTrack.boundingBox()).toEqual(capacityBox);
  await component.update(<PhoneHudLayoutStory safeAreaBottom={34} aggressiveRemainingMs={0} inventoryUsed={0} inventoryTotal={0} />);
  await expect(storageTrack).toHaveAttribute("aria-hidden", "true");
  await expect(storageTrack).toHaveCSS("visibility", "hidden");
  expect(await storageTrack.boundingBox()).toEqual(capacityBox);
});
