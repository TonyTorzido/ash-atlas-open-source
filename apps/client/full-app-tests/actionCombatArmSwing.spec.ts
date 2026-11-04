/**
 * Visual check of the action-combat arm swing: signs in as the dev player, slows the page clock, swings
 * right and left and screenshots the pose at about 60, 150 and 250 ms into the swing.
 *
 * Run (action-combat dev runtime up):
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41768 pnpm exec playwright test --config playwright-full-app.config.ts actionCombatArmSwing
 *
 * Optional env: ASH_ATLAS_E2E_OUT (screenshot folder, default <tmpdir>/action-combat-e2e), ARM_SWING_VARIANT_COMBO=1
 * to press three times quickly so the third swing is the finisher.
 */
import { expect, test, chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
const outDir = process.env.ASH_ATLAS_E2E_OUT ?? join(tmpdir(), "action-combat-e2e");
mkdirSync(outDir, { recursive: true });

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the action-combat dev runtime");

/** The page clock runs at `__clockScale` x real time once set (1 = normal), so a 350 ms swing can be photographed. */
const clockScaleScript = (): void => {
  const nativeNow = performance.now.bind(performance);
  let virtual = 0;
  let lastReal = nativeNow();
  (window as unknown as { __clockScale: number }).__clockScale = 1;
  performance.now = () => {
    const real = nativeNow();
    virtual += (real - lastReal) * (window as unknown as { __clockScale: number }).__clockScale;
    lastReal = real;
    // The clock cannot pass the stop point, so a frame can be photographed exactly there.
    const stop = (window as unknown as { __stopAt?: number }).__stopAt;
    if (stop !== undefined && virtual > stop) virtual = stop;
    return virtual;
  };
  (window as unknown as { __virtualNow: () => number }).__virtualNow = () => performance.now();
};

test("arm swing frames at 60, 150 and 250 ms", async () => {
  test.setTimeout(180_000);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.addInitScript(clockScaleScript);
    let swingsSent = 0;
    page.on("websocket", (ws) => ws.on("framesent", (f) => { if (/"type":"SWING"/.test(String(f.payload))) swingsSent += 1; }));
    await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
    const dev = page.getByRole("button", { name: "Default Dev" });
    await dev.waitFor({ state: "visible", timeout: 20_000 });
    for (let attempt = 0; attempt < 6; attempt++) {
      await dev.click();
      const curtain = page.locator("main.initial-curtain");
      const failed = page.getByText("Authentication service unavailable");
      await curtain.or(failed).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      if (!(await failed.isVisible().catch(() => false))) break;
      await page.waitForTimeout(10_000);
    }
    await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
    await page.waitForTimeout(3000);
    const respawn = page.getByRole("button", { name: "Respawn" });
    if (await respawn.isVisible()) { await respawn.click(); await page.waitForTimeout(2000); }
    await page.screenshot({ path: join(outDir, "arm-swing-context.png") });

    // The map follows the player, so the player stands at the middle of the map area.
    const centre = { x: 640, y: 365 };
    const clip = { x: centre.x - 90, y: centre.y - 130, width: 180, height: 200 };

    for (const side of ["right", "left"] as const) {
      // Clicking a mob swings toward it: the training dummy stands up-left of the player, a hare to the right.
      const aim = side === "left" ? { x: 624, y: 335 } : { x: 730, y: 360 };
      // Let any recovery from the earlier swing end before the next one.
      await page.waitForTimeout(1500);
      await page.evaluate(() => { (window as unknown as { __clockScale: number }).__clockScale = 0; });
      const t0 = await page.evaluate(() => (window as unknown as { __virtualNow: () => number }).__virtualNow());
      const sentBefore = swingsSent;
      await page.mouse.click(aim.x, aim.y);
      await page.evaluate(() => { (window as unknown as { __clockScale: number }).__clockScale = 0.04; });
      console.log(`[arm-swing] ${side} click sent ${swingsSent - sentBefore} SWING frames`);
      for (const targetMs of [60, 150, 250]) {
        // Let the page clock run to exactly t0 + targetMs, where it stops, then photograph that frame.
        await page.evaluate((stop) => { (window as unknown as { __stopAt: number }).__stopAt = stop; }, t0 + targetMs);
        await page.waitForFunction((stop) => (window as unknown as { __virtualNow: () => number }).__virtualNow() >= stop, t0 + targetMs, { polling: 10 });
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(outDir, `arm-swing-${side}-${targetMs}ms.png`), clip });
        console.log(`[arm-swing] ${side} ${targetMs} ms captured`);
      }
      await page.evaluate(() => { delete (window as unknown as { __stopAt?: number }).__stopAt; });
      await page.evaluate(() => { (window as unknown as { __clockScale: number }).__clockScale = 1; });
    }
    expect(true).toBe(true);
  } finally {
    await browser.close();
  }
});
