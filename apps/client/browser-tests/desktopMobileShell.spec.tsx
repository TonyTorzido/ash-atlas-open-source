import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";

import { PresentationShellStory } from "./PresentationShellStory.js";

const desktopSizes = [
  { width: 1024, height: 768, expectedWidth: 981.8125, expectedHeight: 736, branding: false },
  { width: 1366, height: 768, expectedWidth: 981.8125, expectedHeight: 736, branding: true },
  { width: 1440, height: 900, expectedWidth: 1157.8984375, expectedHeight: 868, branding: false },
  { width: 1920, height: 1080, expectedWidth: 1366, expectedHeight: 1024, branding: true }
] as const;

test("phone viewports remain native, full-viewport, and unbranded", async ({ page, mount }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(viewport);
    await setInputCapabilities(page, { touch: true, fine: false, coarse: true });
    const component = await mount(<PresentationShellStory />);
    await expect(page.locator(".app-presentation")).toHaveAttribute(
      "data-gameplay-layout",
      "compact"
    );
    await expect(page.locator(".app-presentation")).toHaveAttribute("data-input-mode", "touch");
    await expect(page.locator(".desktop-shell-branding")).toHaveCount(0);
    await expectBox(page.getByTestId("mobile-app-stage"), {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-profile", "phone");
    await component.unmount();
  }
});

for (const viewport of desktopSizes) {
  test(`centers one bounded mobile stage at ${viewport.width}x${viewport.height}`, async ({
    page,
    mount
  }) => {
    await page.setViewportSize(viewport);
    await mount(<PresentationShellStory />);
    await expect(page.locator(".app-presentation")).toHaveAttribute(
      "data-gameplay-layout",
      "wide"
    );
    await expect(page.locator("html")).toHaveAttribute("data-ui-profile", "phone");
    if (viewport.branding) {
      await expect(page.locator(".desktop-shell-branding")).toBeVisible();
    } else {
      await expect(page.locator(".desktop-shell-branding")).toBeHidden();
    }
    await expect(page.getByTestId("mobile-app-stage")).toHaveCount(1);
    await expectBox(page.getByTestId("mobile-app-stage"), {
      x: (viewport.width - viewport.expectedWidth) / 2,
      y: (viewport.height - viewport.expectedHeight) / 2,
      width: viewport.expectedWidth,
      height: viewport.expectedHeight
    });
    await expectStageContentBox(
      page.getByTestId("mobile-app-stage"),
      page.getByTestId("map-root"),
      page.getByTestId("pixi-canvas")
    );
    expect(await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight
    }))).toEqual({ horizontal: false, vertical: false });
  });
}

test("browser resizing updates the real stage, map, and Pixi bounds without remounting", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await mount(<PresentationShellStory />);
  const root = page.getByTestId("gameplay-root");
  const map = page.getByTestId("map-root");
  const pixi = page.getByTestId("pixi-canvas");
  await root.evaluate((element) => { element.dataset.resizeIdentity = "same-root"; });
  await map.evaluate((element) => { element.dataset.resizeIdentity = "same-map"; });
  await pixi.evaluate((element) => { element.dataset.resizeIdentity = "same-pixi"; });
  await expect(page.locator(".app-presentation")).toHaveAttribute("data-gameplay-layout", "compact");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator(".app-presentation")).toHaveAttribute("data-gameplay-layout", "wide");
  await expectBox(page.getByTestId("mobile-app-stage"), {
    x: 21.09375,
    y: 16,
    width: 981.8125,
    height: 736
  });
  await expectStageContentBox(
    page.getByTestId("mobile-app-stage"),
    page.getByTestId("map-root"),
    page.getByTestId("pixi-canvas")
  );
  await expect(root).toHaveAttribute("data-resize-identity", "same-root");
  await expect(map).toHaveAttribute("data-resize-identity", "same-map");
  await expect(pixi).toHaveAttribute("data-resize-identity", "same-pixi");
  await page.setViewportSize({ width: 600, height: 1024 });
  await expect(page.locator(".app-presentation")).toHaveAttribute("data-gameplay-layout", "compact");
  await expectBox(page.getByTestId("mobile-app-stage"), {
    x: 0,
    y: 0,
    width: 600,
    height: 1024
  });
  await expect(root).toHaveAttribute("data-resize-identity", "same-root");
  await expect(map).toHaveAttribute("data-resize-identity", "same-map");
  await expect(pixi).toHaveAttribute("data-resize-identity", "same-pixi");
});

test("desktop, iPad, and Android tablet resolve to the identical canonical wide component", async ({
  page,
  mount
}) => {
  const environments = [
    {
      name: "desktop",
      viewport: { width: 1440, height: 900 },
      capabilities: { touch: false, fine: true, coarse: false },
      input: "mouse"
    },
    {
      name: "iPad",
      viewport: { width: 1024, height: 768 },
      capabilities: {
        touch: true,
        fine: false,
        coarse: true,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Safari"
      },
      input: "touch"
    },
    {
      name: "Android tablet",
      viewport: { width: 800, height: 1280 },
      capabilities: {
        touch: true,
        fine: false,
        coarse: true,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit Mobile Safari"
      },
      input: "touch"
    }
  ] as const;

  for (const environment of environments) {
    await page.setViewportSize(environment.viewport);
    await setInputCapabilities(page, environment.capabilities);
    const component = await mount(<PresentationShellStory />);
    const presentation = page.locator(".app-presentation");
    await expect(presentation, environment.name).toHaveAttribute("data-layout-component", "PresentationShell");
    await expect(presentation, environment.name).toHaveAttribute("data-gameplay-layout", "wide");
    await expect(presentation, environment.name).toHaveAttribute("data-input-mode", environment.input);
    await expect(page.getByTestId("mobile-app-stage"), environment.name)
      .toHaveAttribute("data-gameplay-ui", "canonical-wide");
    await expect(page.locator("html"), environment.name).toHaveAttribute("data-ui-profile", "phone");
    await expect(page.getByRole("button", { name: "Phone bottom navigation" }), environment.name)
      .toBeVisible();
    await component.unmount();
  }
});

test("login, pending access, onboarding, and gameplay use the same stage authority", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const view of ["login", "pending", "onboarding", "gameplay"] as const) {
    const component = await mount(<PresentationShellStory view={view} />);
    await expect(page.getByTestId("mobile-app-stage")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("data-ui-profile", "phone");
    await expect(page.locator(".desktop-shell-branding")).toBeHidden();
    const journeyRoot = view === "gameplay"
      ? page.getByTestId("gameplay-root")
      : page.locator(".auth-screen");
    await expectStageContentBox(page.getByTestId("mobile-app-stage"), journeyRoot);
    await component.unmount();
  }
});

test("mouse, menu, text input, fixed UI, and the outer background keep stage boundaries", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await mount(<PresentationShellStory />);
  const stage = page.getByTestId("mobile-app-stage");
  const bottom = page.getByRole("button", { name: "Phone bottom navigation" });
  await expectContained(stage, bottom);
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  await page.mouse.click((stageBox?.x ?? 0) + 180, (stageBox?.y ?? 0) + 280);
  await expect(page.getByTestId("map-point")).toHaveText("180,280");
  const actionSheet = page.getByRole("complementary", { name: "Test landmark actions" });
  await expect(actionSheet).toBeVisible();
  await expectContained(stage, actionSheet);
  await actionSheet.getByRole("button", { name: "Cancel" }).click();
  await bottom.click();
  await expect(page.getByTestId("interaction-count")).toHaveText("1");
  await page.getByLabel("Chat").fill("hello");
  await expect(page.getByTestId("interaction-count")).not.toHaveText("1");
  await page.getByRole("button", { name: "Ranger" }).click();
  await expect(page.getByRole("menu", { name: "Player account" })).toBeVisible();
  const beforeOuterClick = await page.getByTestId("interaction-count").textContent();
  await page.mouse.click(20, 20);
  await expect(page.getByTestId("interaction-count")).toHaveText(beforeOuterClick ?? "");
});

test("authorized Test Access portals wide on desktop and closes back to the one game stage", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubTestAccess(page);
  await mount(<PresentationShellStory authorizedAdmin />);
  await page.getByRole("button", { name: "Ranger" }).click();
  await page.getByRole("menuitem", { name: "Test Access" }).click();
  const dialog = page.getByRole("dialog", { name: "Ash Atlas Test Access" });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width).toBeGreaterThan(430);
  expect(dialogBox?.width).toBeLessThanOrEqual(920);
  await expect(page.getByText("tester@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("mobile-app-stage")).toHaveCount(1);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("gameplay-root")).toBeVisible();
});

test("non-admin gameplay exposes no Test Access control", async ({ page, mount }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await mount(<PresentationShellStory />);
  await page.getByRole("button", { name: "Ranger" }).click();
  await expect(page.getByRole("menuitem", { name: "Test Access" })).toHaveCount(0);
});

async function stubTestAccess(page: Page): Promise<void> {
  await page.route("**/api/admin/test-access**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      json: {
        items: [{
          kind: "account",
          accountId: "account-1",
          verifiedEmail: "tester@example.com",
          status: "pending",
          requestedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          lastLoginAt: null,
          playerName: null
        }],
        page: 1,
        pageSize: 25,
        total: 1
      }
    });
  });
}

async function expectBox(
  locator: Locator,
  expected: { x: number; y: number; width: number; height: number }
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeCloseTo(expected.x, 0);
  expect(box?.y).toBeCloseTo(expected.y, 0);
  expect(box?.width).toBeCloseTo(expected.width, 0);
  expect(box?.height).toBeCloseTo(expected.height, 0);
}

async function expectStageContentBox(stage: Locator, ...contents: Locator[]): Promise<void> {
  const stageMetrics = await stage.boundingBox();
  const boxes = await Promise.all(contents.map((locator) => locator.boundingBox()));
  expect(stageMetrics).not.toBeNull();
  expect(boxes.every((box) => box !== null)).toBe(true);
  for (const box of boxes) {
    expect(box?.x).toBeCloseTo(stageMetrics?.x ?? 0, 1);
    expect(box?.y).toBeCloseTo(stageMetrics?.y ?? 0, 1);
    expect(box?.width).toBeCloseTo(stageMetrics?.width ?? 0, 1);
    expect(box?.height).toBeCloseTo(stageMetrics?.height ?? 0, 1);
  }
}

async function expectContained(container: Locator, child: Locator): Promise<void> {
  const [containerBox, childBox] = await Promise.all([
    container.boundingBox(),
    child.boundingBox()
  ]);
  expect(containerBox).not.toBeNull();
  expect(childBox).not.toBeNull();
  expect((childBox?.x ?? 0) >= (containerBox?.x ?? 0)).toBe(true);
  expect((childBox?.y ?? 0) >= (containerBox?.y ?? 0)).toBe(true);
  expect((childBox?.x ?? 0) + (childBox?.width ?? 0))
    .toBeLessThanOrEqual((containerBox?.x ?? 0) + (containerBox?.width ?? 0));
  expect((childBox?.y ?? 0) + (childBox?.height ?? 0))
    .toBeLessThanOrEqual((containerBox?.y ?? 0) + (containerBox?.height ?? 0));
}

async function setInputCapabilities(
  page: Page,
  capabilities: { touch: boolean; fine: boolean; coarse: boolean; userAgent?: string }
): Promise<void> {
  await page.evaluate(({ touch, fine, coarse, userAgent }) => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: touch ? 5 : 0
    });
    if (userAgent) {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: userAgent
      });
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => {
        const explicit = query === "(any-pointer: fine)"
          ? fine
          : query === "(any-pointer: coarse)"
            ? coarse
            : null;
        if (explicit === null) return nativeMatchMedia(query);
        return {
          matches: explicit,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true
        };
      }
    });
  }, capabilities);
}
