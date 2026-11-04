/**
 * Mobile layout polish across a device matrix, portrait and landscape (real headless Chromium).
 * Safe-area insets are simulated through the --sai-* custom properties (styles.css reads them before env()).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41597 pnpm exec playwright test --config playwright-full-app.config.ts iphoneLayoutPolish
 *
 * ASH_ATLAS_STICKS=fixed runs the fixed corner sticks; the default is the floating sticks, where the touch "zones" are
 * the resting corner outlines padded the way the fixed zones were (the rails stay above them).
 *
 * Optional env: ASH_ATLAS_E2E_SHOTS  screenshot folder (iphone-<device>-<orientation>.png, insets drawn as dark bars).
 */
import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
const FLOATING = (process.env.ASH_ATLAS_STICKS ?? "floating") !== "fixed";
const SHOTS = process.env.ASH_ATLAS_E2E_SHOTS ?? "./test-results/e2e-shots";
mkdirSync(SHOTS, { recursive: true });

import { DEVICES, type Insets } from "./iphoneDevices.js";

test.describe.configure({ mode: "serial", timeout: 600_000 });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the action-combat dev runtime");

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

async function signIn(page: Page): Promise<void> {
  await page.addInitScript((floating) => { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); localStorage.setItem("ashAtlas.floatingSticks.v1", floating ? "1" : "0"); } catch { /* ignore */ } }, FLOATING);
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  for (let attempt = 0; attempt < 6; attempt++) {
    await dev.click();
    const failed = page.getByText("Authentication service unavailable");
    await page.locator("main.initial-curtain").or(failed).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    if (!(await failed.isVisible().catch(() => false))) break;
    await page.waitForTimeout(10_000);
  }
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
  await page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "attached", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const respawn = page.getByRole("button", { name: "Respawn" });
  if (await respawn.isVisible().catch(() => false)) { await respawn.click(); await page.waitForTimeout(1500); }
}

async function applyInsets(page: Page, i: Insets): Promise<void> {
  await page.evaluate((v) => {
    let el = document.getElementById("e2e-insets");
    if (!el) { el = document.createElement("style"); el.id = "e2e-insets"; document.head.appendChild(el); }
    el.textContent = `:root{--sai-top:${v.t}px;--sai-right:${v.r}px;--sai-bottom:${v.b}px;--sai-left:${v.l}px}`;
  }, i);
}

async function drawBars(page: Page, i: Insets): Promise<void> {
  await page.evaluate((v) => {
    document.getElementById("e2e-bars")?.remove();
    const wrap = document.createElement("div"); wrap.id = "e2e-bars";
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const bar = (css: string) => { const d = document.createElement("div"); d.style.cssText = `position:absolute;background:rgba(10,8,6,.88);${css}`; wrap.appendChild(d); };
    if (v.t) bar(`left:0;right:0;top:0;height:${v.t}px`);
    if (v.b) bar(`left:0;right:0;bottom:0;height:${v.b}px`);
    if (v.l) bar(`left:0;top:0;bottom:0;width:${v.l}px`);
    if (v.r) bar(`right:0;top:0;bottom:0;width:${v.r}px`);
    document.body.appendChild(wrap);
  }, i);
}

interface R { l: number; t: number; r: number; b: number; w: number; h: number }

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (e: Element): R => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const one = (s: string) => { const e = document.querySelector(s); return e ? rect(e) : null; };
    const slotEls = Array.from(document.querySelectorAll(".ash-hotbar-slot"));
    return {
      vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
      profile: document.documentElement.dataset.uiProfile ?? "", combat: document.documentElement.hasAttribute("data-combat-controls"),
      slots: slotEls.map(rect), clipped: slotEls.filter((e) => getComputedStyle(e).clipPath !== "none").length,
      stick: one(".joystick-move-base"), attackFace: one(".joystick-attack-face"),
      zones: (() => {
        const anchor = document.querySelector(".joystick-rest-anchor");
        const cluster = document.querySelector(".joystick-combat-cluster");
        const px = (name: string): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
        if (anchor && cluster) {
          const pad = (e: Element, up: number): R => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top - up, r: b.right, b: b.bottom, w: b.width, h: b.height + up }; };
          return { stick: pad(anchor, px("--cc-stick-pad-t")), attack: pad(cluster, px("--cc-az-t")) };
        }
        return { stick: one(".joystick-move"), attack: one(".joystick-attack") };
      })(),
      dock: one(".phone-bottom-bar"), chat: one(".chat-top-bar") ?? one(".chat-bar")
    };
  });
}

const hit = (a: R, b: R): boolean => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;

for (const dev of DEVICES) {
  for (const orient of ["portrait", "landscape"] as const) {
    const land = orient === "landscape";
    test(`layout ${dev.name} ${orient}`, async () => {
      const [w, h] = land ? [dev.h, dev.w] : [dev.w, dev.h];
      const ins = land ? dev.landscape : dev.portrait;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      try {
        await signIn(page);
        await applyInsets(page, ins);
        await page.waitForTimeout(700);
        const gotIt = page.getByRole("button", { name: "Got it" });
        if (await gotIt.isVisible().catch(() => false)) { await gotIt.click(); await page.waitForTimeout(500); }
        const m = await measure(page);
        const out: string[] = [];
        const fail = (msg: string) => out.push(msg);
        const sl = ins.l, sr = w - ins.r, sb = h - ins.b;
        const inSafeX = (r: R) => r.l >= sl - 0.5 && r.r <= sr + 0.5;
        // nothing scrolls
        if (m.scrollW > w) fail(`scrollW ${m.scrollW} > ${w}`);
        if (m.scrollH > h) fail(`scrollH ${m.scrollH} > ${h}`);
        // every slot button is complete: inside the viewport and the safe area, never clipped
        if (m.slots.length === 0) fail("no hotbar slots rendered");
        if (m.clipped) fail(`${m.clipped} slots carry a clip-path`);
        for (const s of m.slots) {
          if (!inSafeX(s)) fail(`slot x ${s.l.toFixed(0)}..${s.r.toFixed(0)} outside safe ${sl}..${sr}`);
          if (s.t < 0 || s.b > h) fail(`slot y ${s.t.toFixed(0)}..${s.b.toFixed(0)} outside viewport`);
          if (m.chat && s.t < m.chat.b - 0.5) fail(`slot overlaps chat bar (top ${s.t.toFixed(0)} < ${m.chat.b.toFixed(0)})`);
          if (m.dock && hit(s, m.dock)) fail("slot overlaps dock");
        }
        const zones = [m.zones.stick, m.zones.attack].filter((x): x is R => !!x);
        const faces = [m.stick, m.attackFace].filter((x): x is R => !!x);
        if (!m.combat) fail("combat controls not active");
        if (zones.length < 2) fail(`controls missing (${zones.length}/2)`);
        // controls sit in the safe area, close to the edge
        // Short landscape floating zones own the whole corner out to the screen edges; the visible faces stay in the safe area.
        for (const r of (land && FLOATING ? faces : [...zones, ...faces])) {
          if (!inSafeX(r)) fail(`control x ${r.l.toFixed(0)}..${r.r.toFixed(0)} outside safe ${sl}..${sr}`);
          if (r.b > sb + 0.5) fail(`control bottom ${r.b.toFixed(0)} below safe ${sb}`);
        }
        const shell = w > 800; // tablets centre the app shell, so edge hugging is judged on phones only
        if (!shell && m.stick && m.stick.l - sl > 28) fail(`stick ${(m.stick.l - sl).toFixed(0)}px from the safe edge (want <= 28)`);
        if (!shell && m.attackFace && sr - m.attackFace.r > 28) fail(`attack ${(sr - m.attackFace.r).toFixed(0)}px from the safe edge (want <= 28)`);
        // capped sizes
        if (m.stick && m.stick.w > 105) fail(`stick ${m.stick.w} too big`);
        if (m.attackFace && m.attackFace.w > 97) fail(`attack ${m.attackFace.w} too big`);
        // rails sit just above the tallest zone
        if (m.slots.length && zones.length) {
          const lowest = Math.max(...m.slots.map((s) => s.b));
          const top = Math.min(...zones.map((q) => q.t));
          const gap = top - lowest;
          if (gap > 12.5 || gap < 4) fail(`rail gap ${gap.toFixed(1)} (want 4..12)`);
          for (const s of m.slots) for (const q of zones) if (hit(s, q)) fail("slot overlaps a touch zone");
        }
        // zones never take the dock
        if (m.dock) for (const q of zones) if (hit(q, m.dock)) fail(`touch zone overlaps dock (zone ${q.l.toFixed(0)},${q.t.toFixed(0)},${q.r.toFixed(0)},${q.b.toFixed(0)} dock ${m.dock.l.toFixed(0)},${m.dock.t.toFixed(0)},${m.dock.r.toFixed(0)},${m.dock.b.toFixed(0)})`);
        // short landscape: compact dock strip
        if (land && h <= 520 && m.dock) {
          if (m.dock.h > 56 + ins.b + 0.5) fail(`dock ${m.dock.h.toFixed(0)}px tall (max ${56 + ins.b})`);
          if (m.dock.w > 0.6 * w) fail(`dock ${m.dock.w.toFixed(0)}px wide (> 60% of ${w})`);
          if (Math.abs(m.dock.b - h) > 0.5) fail(`dock bottom ${m.dock.b} is not the screen bottom`);
        }
        await drawBars(page, ins);
        await page.screenshot({ path: join(SHOTS, `iphone-${dev.name}-${orient}.png`) });
        console.log(`[${dev.name} ${orient}] ${JSON.stringify({ dock: m.dock && { w: Math.round(m.dock.w), h: Math.round(m.dock.h) }, stick: m.stick?.w, attack: m.attackFace?.w, slots: m.slots.length, profile: m.profile })} fails=${out.length}`);
        expect(out, `${dev.name} ${orient}`).toEqual([]);
      } finally { await ctx.close(); }
    });
  }
}
