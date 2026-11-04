// Renders the LIVE game's sword idle and melee swing (the real PlayerRenderer + SWING_PROGRAMS.swing + moveSwingHeld)
// to frames, a key-time sheet and GIFs, as the reference for the Atlas Animator sword clips.
// Run from packages/animator:
//   npx tsx scripts/live-sword-reference.ts <game repo checkout> [outDir]
// default game repo C:/Users/dev/Documents/game, default out
// ../../docs/plans/atlas-animator-demos/attacks/sword/live-reference.
// A throwaway page is written into <game>/packages/player-renderer/.live-sword-ref (deleted afterwards), built with
// Vite and opened in headless Chromium with SwiftShader, like src/cli/render.ts. The page drives the renderer with
// explicit timestamps (updateAnimation(now)), so every frame is exact, not wall-clock.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { SWIFTSHADER_ARGS, writeGif, type RenderResult } from "../src/cli/render.js";
import { decodePng, writePng } from "../src/tools/png.js";
import { grid } from "../src/tools/review.js";

const GAME = resolve(process.argv[2] ?? "C:/Users/dev/Documents/game");
const OUT = resolve(process.argv[3] ?? "../../docs/plans/atlas-animator-demos/attacks/sword/live-reference");
const SIDE = (process.env.LIVE_SIDE ?? "left") as "left" | "right";
const ORIGIN = "http://live.ref";
const W = 320;
const H = 320;
const SCALE = 3.6; // character scale on the 320 px frame (the live in-world player is about 45 px tall at 1x)

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#1e2430}</style></head><body><script type="module" src="./main.ts"></script></body></html>`;
const PAGE_TS = `
import { Application, Graphics } from "pixi.js";
import { PixiTextureCache, PlayerRenderer } from "../src/index.ts";
import { playerAppearanceAssetUrl } from "../src/assetRegistry.ts";

const W = ${W}, H = ${H}, SCALE = ${SCALE};
const snapshot = {
  schemaVersion: 1, catalogRevision: 1, revision: 1, bodyVariantId: "default", poseId: "idle", activeHand: "melee",
  slots: { melee: { equipmentDefinitionId: "starter_sword", appearanceId: "sword", cosmeticAppearanceId: null } },
  styles: { hair: "soldier-crop-hair", legs: "black-pants" }
};
let app, renderer, marks;
async function setup() {
  app = new Application();
  await app.init({ width: W, height: H, backgroundColor: 0x1e2430, antialias: true, resolution: 1, preserveDrawingBuffer: true, preference: "webgl" });
  document.body.appendChild(app.canvas);
  renderer = new PlayerRenderer({ local: true, color: 0x38bdf8, textureLoader: new PixiTextureCache(playerAppearanceAssetUrl) });
  renderer.root.scale.set(SCALE);
  renderer.root.position.set(W * 0.56, H * 0.97);
  app.stage.addChild(renderer.root);
  await renderer.updateAppearance(snapshot);
  for (let i = 0; i < 200 && !renderer.appearanceComplete; i++) await new Promise((r) => setTimeout(r, 25));
  const gl = app.renderer.gl;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return { complete: renderer.appearanceComplete, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?" };
}
function weapon() {
  const s = renderer.equipmentSprite("melee");
  // grip pivot (sprite anchor) and the blade tip (top centre of the art) in frame px
  const a = s.anchor;
  const grip = s.toGlobal({ x: 0, y: 0 });
  const tip = s.toGlobal({ x: (0.5 - a.x) * s.texture.width, y: (0 - a.y) * s.texture.height });
  const pommel = s.toGlobal({ x: (0.5 - a.x) * s.texture.width, y: (1 - a.y) * s.texture.height });
  return { grip, tip, pommel, rotationDeg: s.rotation * 180 / Math.PI, scaleX: s.scale.x, anchor: { x: a.x, y: a.y } };
}
let base = 1e6;
function frame(o) {
  renderer.cancelSwing();
  if (o.mode === "rest") {
    renderer.setPose("idle");
    renderer.updateAnimation(base += 10000);
  } else if (o.mode === "action") {
    // the attack_action pose with no swing running (after the 350 ms program, until 700 ms)
    renderer.setPose("attack_action");
    renderer.updateAnimation(base += 10000);
  } else {
    renderer.setPose("attack_action");
    base += 10000;
    renderer.playSwing(o.variant ?? "swing", o.side, base);
    renderer.updateAnimation(base);
    renderer.updateAnimation(base + o.ms);
  }
  app.render();
  return { png: app.canvas.toDataURL("image/png"), weapon: weapon() };
}
globalThis.liveRef = { setup, frame };
`;

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css", ".json": "application/json" };

async function main() {
  const pageDir = join(GAME, "packages", "player-renderer", ".live-sword-ref");
  const outDir = join(pageDir, "dist");
  rmSync(pageDir, { recursive: true, force: true });
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(pageDir, "index.html"), PAGE_HTML);
  writeFileSync(join(pageDir, "main.ts"), PAGE_TS);
  try {
    await build({ root: pageDir, base: "./", logLevel: "warn", configFile: false, build: { outDir, emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 8192 } });
    const browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    try {
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      await page.route(`${ORIGIN}/**`, async (route) => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, "") || "index.html";
        const file = resolve(outDir, path);
        if (!file.startsWith(resolve(outDir)) || !existsSync(file) || !statSync(file).isFile()) return route.fulfill({ status: 404, body: "nf" });
        return route.fulfill({ status: 200, body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${ORIGIN}/index.html`);
      await page.waitForFunction(() => (globalThis as any).liveRef !== undefined, undefined, { timeout: 30_000 }).catch(() => {
        throw new Error(`page failed: ${errors.join("; ")}`);
      });
      const info = await page.evaluate(() => (globalThis as any).liveRef.setup());
      console.log("setup", info, errors);
      const grab = (o: object) => page.evaluate((x) => (globalThis as any).liveRef.frame(x), o) as Promise<{ png: string; weapon: any }>;
      const toBuf = (d: string) => Buffer.from(d.replace(/^data:image\/png;base64,/, ""), "base64");
      // warm the arm cut once
      await grab({ mode: "swing", side: SIDE, ms: 50 });
      mkdirSync(OUT, { recursive: true });

      const KEYS: [string, any][] = [
        ["rest (idle)", { mode: "rest" }],
        ["0 ms press (attack_action)", { mode: "swing", side: SIDE, ms: 0 }],
        ["49 ms windup peak", { mode: "swing", side: SIDE, ms: 49 }],
        ["77 ms strike", { mode: "swing", side: SIDE, ms: 77 }],
        ["105 ms contact", { mode: "swing", side: SIDE, ms: 105 }],
        ["210 ms follow", { mode: "swing", side: SIDE, ms: 210 }],
        ["280 ms return", { mode: "swing", side: SIDE, ms: 280 }],
        ["350 ms end (attack_action)", { mode: "action" }]
      ];
      const tiles = [];
      const keyData: Record<string, unknown> = {};
      mkdirSync(join(OUT, "keys"), { recursive: true });
      for (const [ki, [label, o]] of KEYS.entries()) {
        const f = await grab(o);
        writeFileSync(join(OUT, "keys", `live-sword-${SIDE}-key${ki}.png`), toBuf(f.png));
        tiles.push({ image: decodePng(toBuf(f.png)), label });
        keyData[label] = f.weapon;
      }
      writePng(join(OUT, `live-sword-${SIDE}-keys-sheet.png`), grid(tiles, 4, 2, true));

      // idle -> swing -> idle at 30 fps: 15 idle frames, the press at f15, the 700 ms attack_action window (21 frames,
      // the 350 ms program then the held attack_action pose), back to idle for 15 frames
      const frames: { time: number; png: Buffer }[] = [];
      const swingOnly: { time: number; png: Buffer }[] = [];
      const timeline: unknown[] = [];
      for (let i = 0; i < 51; i++) {
        let o: any;
        if (i < 15 || i >= 36) o = { mode: "rest" };
        else {
          const ms = ((i - 15) * 1000) / 30;
          o = ms < 350 ? { mode: "swing", side: SIDE, ms } : { mode: "action" };
        }
        const f = await grab(o);
        frames.push({ time: i / 30, png: toBuf(f.png) });
        if (i >= 15 && i < 36) swingOnly.push({ time: (i - 15) / 30, png: toBuf(f.png) });
        timeline.push({ f: i, ...o, weapon: f.weapon });
      }
      const result = (fr: { time: number; png: Buffer }[], clip: string): RenderResult => ({ frames: fr, width: W, height: H, fps: 30, clip, renderer: info.renderer, scale: SCALE, missingTextures: [] });
      writeGif(result(frames, "live idle-swing-idle"), join(OUT, `live-sword-${SIDE}-idle-swing-idle-30fps.gif`));
      writeGif(result(swingOnly, "live swing"), join(OUT, `live-sword-${SIDE}-swing-700ms-30fps.gif`));
      // every 30 fps frame of the swing window
      writePng(join(OUT, `live-sword-${SIDE}-swing-30fps-sheet.png`), grid(swingOnly.slice(0, 12).map((f, i) => ({ image: decodePng(f.png), label: `f${i} ${Math.round(f.time * 1000)} ms` })), 6, 2, true));
      writeFileSync(join(OUT, `live-sword-${SIDE}.json`), `${JSON.stringify({ game: GAME, side: SIDE, scale: SCALE, frame: [W, H], renderer: info.renderer, keys: keyData, timeline }, null, 1)}\n`);
      console.log("wrote", OUT, errors.length ? errors : "");
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(pageDir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
