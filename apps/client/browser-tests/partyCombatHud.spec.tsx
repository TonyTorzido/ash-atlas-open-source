import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";

import { PartyCombatHudStory } from "./PartyCombatHudStory.js";

test("four-other-member portrait HUD clears chat, combat controls, rails, and dock", async ({
  page,
  mount
}) => {
  await setPhoneViewport(page, 320, 568, "portrait");
  await mount(<PartyCombatHudStory />);

  const hud = page.getByRole("complementary", { name: "Party combat status" });
  await expect(hud.getByRole("button", { name: /^Target / })).toHaveCount(4);
  await expect(hud.getByText(/Out/)).toBeVisible();
  await expect(hud.getByText(/Offline · Dead/)).toBeVisible();
  await expectRowsFit(hud);
  await expectNoOverlap(hud, page.getByTestId("chat-bar"));
  await expect(page.getByTestId("combat-kit")).toBeHidden();
  await expect(page.getByLabel("Ability rails")).toBeHidden();
  await expectNoOverlap(hud, page.getByTestId("flag-control"));
  await expectNoOverlap(hud, page.getByTestId("recenter-control"));
  await expectNoOverlap(hud, page.getByTestId("resin-control"));
  await expectNoOverlap(hud, page.getByTestId("bottom-dock"));
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await expectInsideViewport(hud, page);
});

test("390px portrait launcher is the only collapsed surface and stays clear of controls", async ({
  page,
  mount
}) => {
  await setPhoneViewport(page, 390, 844, "portrait");
  await mount(<PartyCombatHudStory />);

  const hud = page.getByRole("complementary", { name: "Party combat status" });
  const collapse = hud.getByRole("button", { name: "Collapse party HUD" });
  await expect(collapse).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(hud.getByRole("switch")).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
  await collapse.click();

  const launcher = hud.getByRole("button", { name: "Expand party HUD, 4 other members" });
  await expect(launcher).toBeVisible();
  await expect(hud.getByRole("button")).toHaveCount(1);
  await expectControlsMatch(launcher, page.getByTestId("flag-control"));
  await expectControlsMatch(launcher, page.getByTestId("recenter-control"));
  await expectControlsMatch(launcher, page.getByTestId("resin-control"));
  const [launcherBox, flagBox, chatBox] = await Promise.all([
    launcher.boundingBox(),
    page.getByTestId("flag-control").boundingBox(),
    page.getByTestId("chat-bar").boundingBox()
  ]);
  expect(launcherBox).not.toBeNull();
  expect(flagBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(launcherBox!.x).toBe(flagBox!.x);
  expect(launcherBox!.y - (chatBox!.y + chatBox!.height)).toBeGreaterThanOrEqual(0);
  expect(launcherBox!.y - (chatBox!.y + chatBox!.height)).toBeLessThanOrEqual(8);
  await expectNoOverlap(hud, page.getByTestId("chat-bar"));
  await expectNoOverlap(hud, page.getByTestId("combat-kit"));
  await expectNoOverlap(hud, page.getByTestId("left-ability-rail"));
  await expectNoOverlap(hud, page.getByTestId("right-ability-rail"));
  await expectNoOverlap(hud, page.getByTestId("bottom-dock"));
  await expectInsideViewport(hud, page);

  const collapsedButtonBox = await launcher.boundingBox();
  await launcher.click();
  const closeButton = hud.getByRole("button", { name: "Collapse party HUD" });
  expect(await closeButton.boundingBox()).toEqual(collapsedButtonBox);
  await expect(closeButton).toHaveCSS("background-color", "rgb(13, 11, 8)");
  await expect(closeButton).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(closeButton).toHaveCSS("box-shadow", "none");
  await expect(closeButton.locator(".party-hud-close-glyph")).toHaveText("×");
  await expect(hud.locator(".party-hud-panel")).toHaveCSS("transform-origin", "0px 0px");
  const [switchBox, headerBox] = await Promise.all([
    hud.getByRole("switch", { name: "Allow party members to jump to you" }).boundingBox(),
    hud.locator(".party-combat-hud-header").boundingBox()
  ]);
  expect(switchBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(Math.abs(
    switchBox!.y + switchBox!.height / 2 - (headerBox!.y + headerBox!.height / 2)
  )).toBeLessThanOrEqual(1);
  await expect(hud.getByText("ALLOW JUMP")).toBeVisible();
});

test("four-other-member short-landscape HUD stays in a compact two-by-two roster", async ({
  page,
  mount
}) => {
  await setPhoneViewport(page, 568, 320, "landscape");
  await mount(<PartyCombatHudStory />);

  const hud = page.getByRole("complementary", { name: "Party combat status" });
  await expect(hud.getByRole("button", { name: /^Target / })).toHaveCount(4);
  await expectRowsFit(hud);
  await expect(hud.locator(".party-combat-roster")).toHaveCSS(
    "grid-template-columns",
    /\d+(\.\d+)?px\s+\d+(\.\d+)?px/
  );
  await expectRosterRowCounts(hud, [2, 2]);
  await expectNoOverlap(hud, page.getByTestId("chat-bar"));
  await expect(page.getByTestId("combat-kit")).toBeHidden();
  await expect(page.getByLabel("Ability rails")).toBeHidden();
  await expectNoOverlap(hud, page.getByTestId("flag-control"));
  await expectNoOverlap(hud, page.getByTestId("recenter-control"));
  await expectNoOverlap(hud, page.getByTestId("resin-control"));
  await expectNoOverlap(hud, page.getByTestId("bottom-dock"));
  await expectInsideViewport(hud, page);
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const viewport of [
  { width: 375, height: 812 },
  { width: 393, height: 852 },
  { width: 430, height: 932 }
]) {
  test(`${viewport.width}x${viewport.height} expanded Party shell stays clear and inside the viewport`, async ({
    page,
    mount
  }) => {
    await setPhoneViewport(page, viewport.width, viewport.height, "portrait");
    await mount(<PartyCombatHudStory />);
    const hud = page.getByRole("complementary", { name: "Party combat status" });
    await expectInsideViewport(hud, page);
    await expectNoOverlap(hud, page.getByTestId("chat-bar"));
    await expectNoOverlap(hud, page.getByTestId("flag-control"));
    await expectNoOverlap(hud, page.getByTestId("recenter-control"));
    await expectNoOverlap(hud, page.getByTestId("resin-control"));
    await expectNoOverlap(hud, page.getByTestId("bottom-dock"));
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("desktop HUD stays compact and vertically ordered", async ({ page, mount }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    delete document.documentElement.dataset.uiProfile;
    delete document.documentElement.dataset.orientation;
  });
  await mount(<PartyCombatHudStory />);

  const hud = page.getByRole("complementary", { name: "Party combat status" });
  const rows = hud.getByRole("button", { name: /^Target / });
  await expect(rows).toHaveCount(4);
  await expectRowsFit(hud);
  await expectRosterRowCounts(hud, [2, 2]);
});

for (const scenario of [
  { count: 1 as const, rowCounts: [1], follower: false },
  { count: 2 as const, rowCounts: [1, 1], follower: false },
  { count: 3 as const, rowCounts: [1, 2], follower: true },
  { count: 4 as const, rowCounts: [2, 2], follower: false }
]) {
  test(`${scenario.count} other member${scenario.count === 1 ? "" : "s"} use the requested two-row roster`, async ({
    page,
    mount
  }) => {
    await setPhoneViewport(page, 390, 844, "portrait");
    await mount(
      <PartyCombatHudStory
        otherMemberCount={scenario.count}
        follower={scenario.follower}
      />
    );

    const hud = page.getByRole("complementary", { name: "Party combat status" });
    const rows = hud.getByRole("button", { name: /^Target / });
    await expect(rows).toHaveCount(scenario.count);
    await expectRosterRowCounts(hud, scenario.rowCounts);
    if (scenario.count === 3) {
      await expect(rows.first()).toHaveAccessibleName(/Target Stoneheart/);
      await expect(rows.first().locator('[title="Party leader"]')).toBeVisible();
      const boxes = await rows.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON())
      );
      expect(boxes[0]!.width).toBeGreaterThan(boxes[1]!.width * 1.9);
    }
  });
}

test("reduced motion removes party panel and health transitions", async ({ page, mount }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(<PartyCombatHudStory />);
  await expect(page.locator(".party-hud-panel")).toHaveCSS("transition-duration", "0s");
  await expect(page.locator(".party-health-track i").first()).toHaveCSS("transition-duration", "0s");
});

async function setPhoneViewport(
  page: Page,
  width: number,
  height: number,
  orientation: "portrait" | "landscape"
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate((value) => {
    document.documentElement.dataset.uiProfile = "phone";
    document.documentElement.dataset.orientation = value;
  }, orientation);
}

async function expectRowsFit(hud: Locator): Promise<void> {
  const rows = hud.getByRole("button", { name: /^Target / });
  const rowHeights = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height)
  );
  for (const height of rowHeights) {
    expect(height).toBeGreaterThanOrEqual(32);
    expect(height).toBeLessThanOrEqual(38);
  }
  const rosterOverflow = await hud.locator(".party-combat-roster").evaluate((element) => ({
    horizontal: element.scrollWidth > element.clientWidth,
    vertical: element.scrollHeight > element.clientHeight
  }));
  expect(rosterOverflow).toEqual({ horizontal: false, vertical: false });
}

async function expectRosterRowCounts(hud: Locator, expectedCounts: number[]): Promise<void> {
  const boxes = await hud.getByRole("button", { name: /^Target / }).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().toJSON())
  );
  const rowCounts = new Map<number, number>();
  for (const box of boxes) {
    const top = Math.round(box.top);
    rowCounts.set(top, (rowCounts.get(top) ?? 0) + 1);
  }
  expect([...rowCounts.values()]).toEqual(expectedCounts);
  expect(rowCounts.size).toBeLessThanOrEqual(2);
}

async function expectInsideViewport(locator: Locator, page: Page): Promise<void> {
  const [box, viewport] = await Promise.all([
    locator.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  ]);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

async function expectControlsMatch(first: Locator, second: Locator): Promise<void> {
  const properties = [
    "width",
    "height",
    "padding",
    "border-radius",
    "border-color",
    "color",
    "background-image",
    "background-color",
    "box-shadow"
  ];
  const [firstStyles, secondStyles] = await Promise.all([
    first.evaluate((element, names) => {
      const styles = getComputedStyle(element);
      return names.map((name) => styles.getPropertyValue(name));
    }, properties),
    second.evaluate((element, names) => {
      const styles = getComputedStyle(element);
      return names.map((name) => styles.getPropertyValue(name));
    }, properties)
  ]);
  expect(firstStyles).toEqual(secondStyles);
}

async function expectNoOverlap(first: Locator, second: Locator): Promise<void> {
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const overlaps = firstBox!.x < secondBox!.x + secondBox!.width
    && firstBox!.x + firstBox!.width > secondBox!.x
    && firstBox!.y < secondBox!.y + secondBox!.height
    && firstBox!.y + firstBox!.height > secondBox!.y;
  expect(overlaps).toBe(false);
}
