import { expect, test } from "@playwright/experimental-ct-react";

import { MessagesNavigationStory } from "./MessagesNavigationStory.js";

test.use({ viewport: { width: 390, height: 844 } });

test("Messages follows one-level Back and reset-on-return navigation on mobile", async ({
  page,
  mount
}) => {
  await mount(<MessagesNavigationStory />);
  await page.getByRole("button", { name: "Open Game Menu" }).click();
  await page.getByRole("button", { name: "Open Messages" }).click();

  const footerButtons = page.locator(".phone-menu-footer button");
  await expect(footerButtons).toHaveText(["Back to Game Menu", "Return to Game"]);
  await expect(page.getByText("Courier Ledger")).toHaveCount(0);
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Personal" }).click();
  await page.getByRole("button", { name: /Atlas Friend/ }).click();
  await expect(page.getByRole("region", { name: "Conversation with Atlas Friend" })).toBeVisible();
  await expect(footerButtons).toHaveText(["Back to Messages", "Return to Game"]);
  await expect(page.locator(".direct-messages-panel--phone-conversation .phone-menu-back svg")).toHaveCount(0);
  expect(await page.evaluate(() => window.history.state.ashAtlasChatOverlay)).toBeUndefined();
  await page.getByRole("button", { name: "Back to Messages", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Personal" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("tab", { name: "Notifications" }).click();
  await page.getByRole("button", { name: "Read Travel Invitation from Traveler" }).click();
  await expect(page.getByRole("region", { name: "Travel Invitation from Traveler" })).toBeVisible();
  await expect(page.locator(".mobile-inbox-detail > header button")).toHaveCount(0);
  await expect(footerButtons).toHaveText(["Back", "Return to Game"]);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Notifications" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Read Travel Invitation from Traveler" }).click();
  await page.getByRole("button", { name: "Return to Game" }).click();
  await expect(page.getByRole("region", { name: "Gameplay" })).toBeVisible();
  await page.getByRole("button", { name: "Open Game Menu" }).click();
  await page.getByRole("button", { name: "Open Messages" }).click();
  await expect(page.getByRole("dialog", { name: "Messages" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Inbox" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Personal" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mobile-inbox-detail")).toHaveCount(0);
  await expect(page.locator(".direct-message-conversation")).toHaveCount(0);

  await page.getByRole("button", { name: "Back to Game Menu", exact: true }).click();
  await expect(page.getByRole("region", { name: "Game Menu" })).toBeVisible();

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Open Atlas Chats" }).click();
  await page.getByRole("button", { name: "Message Atlas Friend" }).click();
  await expect(page.getByRole("region", { name: "Conversation with Atlas Friend" })).toBeVisible();
  await expect(footerButtons).toHaveText(["Back to Atlas Chats", "Return to Game"]);
  await page.getByRole("button", { name: "Back to Atlas Chats" }).click();
  await expect(page.getByRole("complementary", { name: "Atlas Chats" })).toBeVisible();
});
