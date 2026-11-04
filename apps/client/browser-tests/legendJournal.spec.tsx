import { expect, test } from "@playwright/experimental-ct-react";
import { LegendJournalStory } from "./LegendJournalStory.js";

for (const layout of ["phone", "desktop"] as const) {
  test("journal remains usable in the " + layout + " Progression shell", async ({ page, mount }, testInfo) => {
    await page.setViewportSize(layout === "phone" ? { width: 360, height: 740 } : { width: 1280, height: 900 });
    await page.evaluate((phone) => {
      document.documentElement.dataset.uiProfile = phone ? "phone" : "desktop";
      document.documentElement.dataset.layoutMode = phone ? "compact" : "expanded";
    }, layout === "phone");
    await page.route("**/api/legends", (route) => route.fulfill({ json: {
      playerId: "journal-browser", metrics: { kills_total: 120, harvests_total: 40 }, completed: {}, newlyCompletedIds: [], serverTime: 1_800_000_000_000
    } }));
    await mount(<LegendJournalStory layout={layout} />);
    const journal = page.getByRole("region", { name: "Atlas Legends journal" });
    await expect(journal.getByRole("heading", { name: "Wayfarer" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("journal-overview-" + layout + ".png") });
    const scroll = journal.locator(".legend-journal-scroll");
    expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const subTabs = journal.getByRole("tablist", { name: "Journal views" });
    const before = await subTabs.boundingBox();
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const after = await subTabs.boundingBox();
    expect(after?.y).toBe(before?.y);
    await expect(page.getByRole("button", { name: "Return to Game", exact: true })).toBeVisible();
    await subTabs.getByRole("tab", { name: "Achievements", exact: true }).click();
    await expect(journal.locator("[data-legend-id]")).toHaveCount(12);
    await journal.getByRole("searchbox").fill("Venom Core");
    await journal.getByRole("combobox", { name: "Category" }).selectOption("Mastery");
    await journal.getByRole("combobox", { name: "Difficulty" }).selectOption("Veteran");
    await journal.getByRole("combobox", { name: "Status" }).selectOption("in-progress");
    const bitterBlood = journal.locator('[data-legend-id="bitter_blood"]');
    await expect(bitterBlood).toHaveCount(1);
    await expect(journal.getByRole("heading", { name: "Bitter Blood", exact: true })).toHaveCount(0);
    await bitterBlood.locator("summary").click();
    await expect(bitterBlood.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "74");
    await expect(bitterBlood.getByText(/Venom Core.*Venomsteel/)).toBeVisible();
    await bitterBlood.getByRole("button", { name: "Pin Bitter Blood" }).click();
    await subTabs.getByRole("tab", { name: "Pinned", exact: true }).click();
    await expect(journal.locator("[data-legend-id]")).toHaveCount(1);
    await expect(bitterBlood).toBeVisible();

    await subTabs.getByRole("tab", { name: "Quests", exact: true }).click();
    await journal.getByRole("combobox", { name: "Status" }).selectOption("locked");
    await journal.locator("[data-legend-id] summary").first().click();
    await expect(journal.getByText("Chapter locked.", { exact: true }).first()).toBeVisible();
    expect(await journal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await journal.locator("details[open] .legend-journal-detail").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("journal-" + layout + ".png") });
  });
}
