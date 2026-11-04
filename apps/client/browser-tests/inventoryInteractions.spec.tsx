import { expect, test } from "@playwright/experimental-ct-react";
import { InventoryInteractionStory } from "./InventoryInteractionStory.js";

const output = "./test-results/inventory-qa";

for (const layout of ["desktop", "phone"] as const) {
  test(`${layout} list keeps capacity and category controls visible while scrolling`, async ({ page, mount }) => {
    await page.setViewportSize(layout === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.evaluate((profile) => document.documentElement.setAttribute("data-ui-profile", profile), layout);
    await mount(<InventoryInteractionStory layout={layout} />);
    await expect(page.getByRole("progressbar", { name: "Carrying capacity" })).toHaveAttribute("aria-valuetext", /of 150 kg/);
    await expect(page.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true");
    const categories = page.getByRole("tablist", { name: "Inventory categories" });
    const before = await categories.boundingBox();
    await page.locator(".inventory-carry-scroll").evaluate((element) => element.scrollTop = 1000);
    expect((await categories.boundingBox())?.y).toBe(before?.y);
    for (const name of ["All", "Equipment", "Resources", "Consumables"]) await expect(categories.getByRole("tab", { name, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Equipment", exact: true }).click();
    await expect(page.getByRole("button", { name: /Starter Sword, quantity/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Wood, quantity/ })).toHaveCount(0);
    await page.getByRole("tab", { name: "Consumables", exact: true }).click();
    await expect(page.getByRole("button", { name: /Simple Food, quantity/ })).toBeVisible();
    await page.getByRole("tab", { name: "All", exact: true }).click();
    await page.locator(".inventory-carry-scroll").evaluate((element) => element.scrollTop = 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/inventory-${layout}.png` });
  });
}

test("large commodity balances support exact partial drops without splitting", async ({ page, mount }) => {
  await mount(<InventoryInteractionStory />);
  await page.getByRole("tab", { name: "Resources", exact: true }).click();
  const wood = page.getByRole("button", { name: /Wood, quantity 437,/ });
  await wood.scrollIntoViewIfNeeded();
  await wood.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Wood actions", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Split|Restack|Move$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Drop", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Drop amount", exact: true }).fill("237");
  await page.screenshot({ path: `${output}/inventory-quantity-picker.png` });
  await page.getByRole("button", { name: /Drop 237/ }).click();
  await expect(page.getByRole("button", { name: /Wood, quantity 200,/ })).toBeVisible();
  expect(await page.evaluate(() => window.inventoryTestDrops)).toEqual([237]);
});

test("phone taps open item actions and horizontal category keyboard navigation remains available", async ({ page, context, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute("data-ui-profile", "phone"));
  await mount(<InventoryInteractionStory layout="phone" />);
  const all = page.getByRole("tab", { name: "All", exact: true });
  await all.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Equipment", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Consumables", exact: true }).click();
  const row = page.getByRole("button", { name: /Simple Food, quantity/ });
  const box = await row.boundingBox();
  if (!box) throw new Error("Missing consumable row");
  const session = await context.newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByLabel("Simple Food actions", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${output}/inventory-phone-actions.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toBeFocused();
});
