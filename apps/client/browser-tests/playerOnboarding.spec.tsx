import { expect, test } from "@playwright/experimental-ct-react";

import { PlayerNameScreen } from "../src/ui/PlayerNameScreen.js";

test("requires a strict name and one of five non-black personal colors", async ({ page, mount }) => {
  await mount(
    <PlayerNameScreen
      busy={false}
      message={null}
      onSubmit={async () => undefined}
      onLogout={async () => undefined}
    />
  );

  const submit = page.getByRole("button", { name: "Create Player" });
  await expect(page.getByRole("radio")).toHaveCount(5);
  await expect(page.getByRole("radio", { name: /black/i })).toHaveCount(0);
  await expect(submit).toBeDisabled();

  await page.getByLabel("Display name").fill(" Avery ");
  await expect(page.getByText("Use 3-20 English letters only.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.getByLabel(/Display name/).fill("Avery");
  await page.getByRole("radio", { name: "Gold" }).check();
  await expect(submit).toBeEnabled();
  await expect(page.getByRole("radio", { name: "Gold" })).toBeChecked();
  await expect(page.locator(".flag-color-option.selected", { hasText: "Gold" })).toContainText("Gold");
});

test("onboarding remains scrollable inside a phone safe area", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiProfile = "phone";
  });
  await mount(
    <PlayerNameScreen
      busy={false}
      message={null}
      onSubmit={async () => undefined}
      onLogout={async () => undefined}
    />
  );

  const authScreen = page.locator(".auth-screen");
  await expect(page.getByRole("heading", { name: "Create your player" })).toBeVisible();
  await expect(authScreen).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => authScreen.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => authScreen.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await authScreen.hover();
  await page.mouse.wheel(0, 360);
  await expect.poll(() => authScreen.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await expect(page.getByRole("button", { name: "Create Player" })).toBeVisible();
});
