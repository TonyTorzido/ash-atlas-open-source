/**
 * Overworld music + Sound settings, end to end in headless Chromium at phone size (390x844) against a feature runtime
 * with ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED and MOB_ARCHETYPES_ENABLED true.
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41888 pnpm exec playwright test --config playwright-full-app.config.ts musicLoop
 *
 * - the browser (no autoplay) preloads the files at boot but plays nothing before a click, then the loop starts after the first click
 * - Settings -> Gameplay -> Map has Master / Music / Sound effects sliders and a Music toggle that persist across a reload
 * - moving a slider changes the matching bus gain
 * - the Music toggle off stops the loop; on starts it again
 * - the music ducks by 40% while a mob is attacking the player and returns afterwards
 */
import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { launch, baseUrl, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 240_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=document-user-activation-required"] }); });
test.afterAll(async () => { await browser?.close(); });

type AudioStats = { ctxState: string; loaded: boolean; playing: boolean; startCount: number; stopCount: number; master: number; music: number; sfx: number; duck: number; track: number };
const stats = (page: Page): Promise<AudioStats | null> =>
  page.evaluate(() => (window as unknown as { __ASH_ATLAS_AUDIO__?: () => AudioStats }).__ASH_ATLAS_AUDIO__?.() ?? null);

async function openSoundSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Open Game Menu/ }).click();
  await page.getByRole("button", { name: "Settings & Support" }).click();
  await page.getByRole("tab", { name: "Map" }).click();
}

async function setRange(page: Page, label: string, value: number): Promise<void> {
  await page.getByLabel(label, { exact: true }).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function dismissIntro(page: Page): Promise<void> {
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
}

test("music starts after a click, sliders persist and change the gain, the toggle stops it, combat ducks it", async () => {
  const { ctx, s } = await launch(browser, "music-loop", { viewport: { width: 390, height: 844 }, joystick: true, storage: { "ashAtlas.floatingSticks.v1": "0" } });
  const page = s.page;
  await dismissIntro(page);

  // Nothing plays before the first gesture the audio module sees (launch clicked sign-in before it could load, so
  // reload fresh and only look before touching the page).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => stats(page), { timeout: 30_000 }).not.toBeNull();
  // Boot preloads (context made, files fetched and decoded) but a browser keeps it suspended until a gesture.
  await expect.poll(async () => (await stats(page))?.loaded, { timeout: 30_000 }).toBe(true);
  // A reload can leave Chromium with carried-over activation, so only the invariant is asserted: a suspended context
  // never plays (the unit tests cover the strict no-gesture case).
  const boot = (await stats(page))!;
  if (boot.ctxState !== "running") expect(boot.playing).toBe(false);

  await page.mouse.click(195, 300);
  await expect.poll(async () => (await stats(page))?.playing, { timeout: 30_000 }).toBe(true);
  let st = (await stats(page))!;
  expect(st.ctxState).toBe("running");
  expect(st.master).toBeCloseTo(0.64, 2);
  expect(st.music).toBeCloseTo(0.36, 2);
  expect(st.sfx).toBeCloseTo(0.64, 2);
  await expect.poll(async () => (await stats(page))!.track, { timeout: 10_000 }).toBeGreaterThan(0.9);

  // Sliders exist with the defaults and drive the buses.
  await dismissIntro(page);
  await openSoundSettings(page);
  await expect(page.getByLabel("Master volume", { exact: true })).toHaveValue("80");
  await expect(page.getByLabel("Music volume", { exact: true })).toHaveValue("60");
  await expect(page.getByLabel("Sound effects volume", { exact: true })).toHaveValue("80");
  await expect(page.getByLabel("Music on", { exact: true })).toBeChecked();
  await setRange(page, "Master volume", 50);
  await setRange(page, "Music volume", 100);
  await setRange(page, "Sound effects volume", 20);
  await expect.poll(async () => (await stats(page))!.master, { timeout: 5000 }).toBeCloseTo(0.25, 2);
  await expect.poll(async () => (await stats(page))!.music, { timeout: 5000 }).toBeCloseTo(1, 2);
  await expect.poll(async () => (await stats(page))!.sfx, { timeout: 5000 }).toBeCloseTo(0.04, 2);

  // Persist across a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => stats(page), { timeout: 30_000 }).not.toBeNull();
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 }).catch(() => undefined);
  await page.mouse.click(195, 300);
  await expect.poll(async () => (await stats(page))?.master, { timeout: 30_000 }).toBeCloseTo(0.25, 2);
  await dismissIntro(page);
  await openSoundSettings(page);
  await expect(page.getByLabel("Master volume", { exact: true })).toHaveValue("50");
  await expect(page.getByLabel("Music volume", { exact: true })).toHaveValue("100");
  await expect(page.getByLabel("Sound effects volume", { exact: true })).toHaveValue("20");

  // Music off stops the loop; on starts it again.
  await expect.poll(async () => (await stats(page))?.playing, { timeout: 30_000 }).toBe(true);
  await page.getByLabel("Music on", { exact: true }).uncheck();
  await expect.poll(async () => (await stats(page))!.playing, { timeout: 5000 }).toBe(false);
  await page.getByLabel("Music on", { exact: true }).check();
  await expect.poll(async () => (await stats(page))!.playing, { timeout: 5000 }).toBe(true);
  expect((await stats(page))!.startCount).toBeGreaterThanOrEqual(2);

  await ctx.close();
});

test("music ducks 40% while a mob is attacking the player", async () => {
  const { ctx, s } = await launch(browser, "music-duck", { viewport: { width: 390, height: 844 }, joystick: true, storage: { "ashAtlas.floatingSticks.v1": "0" } });
  const page = s.page;
  await dismissIntro(page);
  await page.mouse.click(195, 300);
  await expect.poll(async () => (await stats(page))?.playing, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await stats(page))!.duck).toBe(1);
  await s.spawn("wolf", 6, 0);
  await expect.poll(async () => (await stats(page))!.duck, { timeout: 30_000 }).toBeCloseTo(0.6, 2);
  await s.clearMobs();
  await expect.poll(async () => (await stats(page))!.duck, { timeout: 30_000 }).toBeCloseTo(1, 2);
  await ctx.close();
});
