/**
 * Line quality (docs/plans/line-quality.md): screenshots of the movement leash circle, the dashed gameplay-view ring and the
 * MapLibre border/zone lines at 430x932 DPR 3, standing and while walking (static-follow freeze active).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41810 ASH_ATLAS_LINE_SHOTS=docs/plans/line-quality LABEL=after \
 *     pnpm exec playwright test --config playwright-full-app.config.ts lineQuality
 */
import { test, chromium, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, baseUrl } from "./e2eSession.js";

test.skip(!baseUrl || !process.env.ASH_ATLAS_LINE_SHOTS, "needs a runtime and ASH_ATLAS_LINE_SHOTS");
test.describe.configure({ mode: "serial", timeout: 180_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] }); });
test.afterAll(async () => { await browser?.close(); });

test("line quality screenshots", async () => {
  const dir = resolve(process.env.ASH_ATLAS_LINE_SHOTS!);
  mkdirSync(dir, { recursive: true });
  const label = process.env.LABEL ?? "shot";
  const { s } = await launch(browser, "line-quality", { viewport: { width: 430, height: 932 }, joystick: true, dpr: 3, storage: { "ashAtlas.floatingSticks.v1": "0" } });
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await s.page.getByRole("button", { name: /Tap to center the map on you/ }).first().tap({ timeout: 8000 }).catch(() => undefined);
  await s.page.waitForTimeout(2500);
  await s.page.screenshot({ path: `${dir}/${label}-full.png` });
  // Crops at device pixels (clip is in CSS px, output is 3x): top edge of the rings, where the arcs are most visible.
  await s.page.screenshot({ path: `${dir}/${label}-crop-top.png`, clip: { x: 105, y: 40, width: 220, height: 160 } });
  await s.page.screenshot({ path: `${dir}/${label}-crop-mid.png`, clip: { x: 0, y: 330, width: 140, height: 140 } });
  await s.page.keyboard.down("d");
  await s.page.waitForTimeout(1800);
  await s.page.screenshot({ path: `${dir}/${label}-walk-full.png` });
  await s.page.screenshot({ path: `${dir}/${label}-walk-crop-top.png`, clip: { x: 105, y: 40, width: 220, height: 160 } });
  await s.page.keyboard.up("d");
});
