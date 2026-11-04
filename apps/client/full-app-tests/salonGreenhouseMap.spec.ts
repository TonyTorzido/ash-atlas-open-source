/**
 * Salon and Greenhouse on the main map renderer (INTERIOR_MAP_RENDERER.md P4): entered through the client UI, drawn by
 * the map, keys/stick/double-tap walk them with the camera following, and their main interactions open from map taps.
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=<dir> pnpm exec playwright test --config playwright-full-app.config.ts salonGreenhouseMap
 */
import { expect, test, chromium, type Page } from "@playwright/test";

import { launch, TEST_SPOT, type Session } from "./e2eSession.js";

// Timeline rooms use the standard_indoor profile: room units -> map lngLat, as interiorSpace.ts does.
const METERS_PER_UNIT = 125 / 260;
const METERS_PER_DEGREE = 2 * Math.PI * 6_371_008.8 / 360;
const roomLngLat = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x * METERS_PER_UNIT / METERS_PER_DEGREE,
  lat: -p.y * METERS_PER_UNIT / METERS_PER_DEGREE
});
const roomScreen = (page: Page, p: { x: number; y: number }): Promise<{ x: number; y: number }> =>
  page.evaluate(({ lng, lat }) => {
    const at = (window as any).__e2eMap.project([lng, lat]);
    return { x: at.x as number, y: at.y as number };
  }, roomLngLat(p));
const worldScreen = (page: Page, p: { lat: number; lon: number }): Promise<{ x: number; y: number }> =>
  page.evaluate(({ lat, lon }) => {
    const at = (window as any).__e2eMap.project([lon, lat]);
    return { x: at.x as number, y: at.y as number };
  }, p);

const SALON_CHAIR = { x: 500, y: 170 };
const SALON_DOOR = { x: 830, y: 830 };

function latest(s: Session, types: string[]): any | null {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir === "in" && types.includes(f.type)) return JSON.parse(f.raw);
  }
  return null;
}

/** Keys, stick and double-tap in the current timeline room; returns the off-centre ratio while walking. */
async function walkChecks(s: Session, label: string, posOf: () => { x: number; y: number }, tapTarget: { x: number; y: number }): Promise<void> {
  const viewport = s.page.viewportSize()!;
  const offCentre = async (): Promise<number> => {
    const at = await roomScreen(s.page, posOf());
    return Math.hypot(at.x - viewport.width / 2, at.y - viewport.height / 2) / Math.min(viewport.width, viewport.height);
  };
  const before = posOf();
  const walkMark = s.mark();
  await s.page.keyboard.down("w");
  const start = Date.now();
  await s.page.waitForTimeout(800);
  await s.shot(`${label}-walking-keys-centred`);
  const centred = await offCentre();
  await s.page.keyboard.up("w");
  const heldMs = Date.now() - start;
  await s.page.waitForTimeout(1200);
  const afterKeys = posOf();
  const units = Math.hypot(afterKeys.x - before.x, afterKeys.y - before.y);
  console.log(label, "keys", JSON.stringify(before), "->", JSON.stringify(afterKeys), "u/s", Math.round(units / (heldMs / 1000)), "off-centre", centred.toFixed(3));
  expect(afterKeys.y, `${label}: keys walk north`).toBeLessThan(before.y - 60);
  // Speed from the server's own position frames (key hold time is skewed by screenshot time and the wall clamp).
  const walkFrames = s.since(walkMark).filter((f) => f.dir === "in" && /_POSITION$/.test(f.type)).map((f) => JSON.parse(f.raw))
    .filter((f) => typeof f.serverTime === "number" && f.position);
  let walkUnits = 0; let walkMs = 0;
  for (let i = 1; i < walkFrames.length; i++) {
    const a = walkFrames[i - 1]; const b = walkFrames[i];
    if (!a.position.moving) continue;
    walkUnits += Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);
    walkMs += b.serverTime - a.serverTime;
  }
  const serverSpeed = walkMs > 0 ? walkUnits / (walkMs / 1000) : units / (heldMs / 1000);
  console.log(label, "server walk speed u/s", Math.round(serverSpeed), "frames", walkFrames.length);
  expect(serverSpeed, `${label}: no faster than 260 u/s plus tolerance`).toBeLessThan(260 * 1.15);
  expect(centred, `${label}: the camera keeps the player near the centre while walking`).toBeLessThan(0.2);

  const stick = s.page.locator(".joystick-move-base").first();
  const box = await stick.boundingBox();
  expect(box, `${label}: the stick is on screen`).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await s.page.mouse.move(cx, cy);
  await s.page.mouse.down();
  await s.page.mouse.move(cx + 40, cy, { steps: 6 });
  await s.page.waitForTimeout(700);
  await s.shot(`${label}-walking-stick`);
  await s.page.mouse.up();
  await s.page.waitForTimeout(800);
  const afterStick = posOf();
  console.log(label, "stick", JSON.stringify(afterKeys), "->", JSON.stringify(afterStick));
  expect(afterStick.x, `${label}: the stick walks east`).toBeGreaterThan(afterKeys.x + 20);

  const tapAt = await roomScreen(s.page, tapTarget);
  await s.page.mouse.dblclick(tapAt.x, tapAt.y);
  await s.page.waitForTimeout(3000);
  const afterTap = posOf();
  console.log(label, "double-tap", JSON.stringify(afterStick), "->", JSON.stringify(afterTap));
  await s.shot(`${label}-after-double-tap`);
  expect(Math.hypot(afterTap.x - afterStick.x, afterTap.y - afterStick.y), `${label}: a map double-tap walks the room`).toBeGreaterThan(20);
}

async function clickNear(s: Session, at: { x: number; y: number }, button: ReturnType<Page["getByRole"]>, offsets: number[]): Promise<boolean> {
  for (const dy of offsets) {
    await s.page.mouse.click(at.x, at.y + dy);
    await s.page.waitForTimeout(700);
    if (await button.isVisible().catch(() => false)) return true;
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(300);
  }
  return false;
}

/** Phone Construction menu -> Greenhouse card (Build or Enter lives on it). */
async function openGreenhouseConstruction(s: Session): Promise<void> {
  await s.page.getByRole("button", { name: /Construction/ }).first().click({ timeout: 10_000 });
  await s.page.waitForTimeout(1200);
  await s.page.getByText("Greenhouse", { exact: true }).first().click({ timeout: 10_000 });
  await s.page.waitForTimeout(1000);
}

test("salon and greenhouse: drawn by the map, entered through the UI, walked with keys/stick/double-tap, interactions from map taps", async () => {
  test.setTimeout(600_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "salon-greenhouse-map", { joystick: true, skipTeleport: true });
  try {
    await s.page.waitForTimeout(6000);
    // An earlier run may have left the player inside: the reconnect must resume on the map path, then walk out.
    await s.shot("18-after-load");
    console.log("location at load", JSON.stringify(latest(s, ["PLAYER_LOCATION_SNAPSHOT"])?.location ?? null).slice(0, 300),
      "salon frames", s.frames.filter((f) => f.dir === "in" && f.type.startsWith("SALON")).map((f) => f.type).join(","));
    if (await s.page.locator(".salon-map-hud").count() > 0 || await s.page.locator(".salon-room").count() > 0) {
      await s.shot("19-salon-reconnect-on-map");
      expect(await s.page.locator(".salon-room").count(), "a Salon reconnect resumes on the map path").toBe(0);
      await s.page.keyboard.down("s");
      await s.page.keyboard.down("d");
      await s.page.waitForTimeout(2200);
      await s.page.keyboard.up("s");
      await s.page.keyboard.up("d");
      await s.page.waitForTimeout(1500);
      console.log("reconnect salon position", JSON.stringify(latest(s, ["SALON_POSITION", "SALON_ENTERED"])));
      await s.shot("19b-salon-reconnect-walked");
      await s.page.mouse.click(...Object.values(await roomScreen(s.page, SALON_DOOR)) as [number, number]);
      await s.page.waitForTimeout(800);
      await s.page.getByRole("button", { name: "Leave Salon" }).click({ timeout: 5000 });
      await s.page.waitForTimeout(8000);
    }
    if (await s.page.locator(".greenhouse-map-hud").count() > 0 || await s.page.locator(".greenhouse-room").count() > 0) {
      await s.shot("19-greenhouse-reconnect-on-map");
      expect(await s.page.locator(".greenhouse-room").count(), "a Greenhouse reconnect resumes on the map path").toBe(0);
      await s.page.mouse.click(s.page.viewportSize()!.width / 2, s.page.viewportSize()!.height / 2 - 20);
      await s.page.waitForTimeout(800);
      await s.page.getByRole("button", { name: "Exit Greenhouse" }).click({ timeout: 5000 });
      await s.page.waitForTimeout(8000);
    }
    // ---------------- Salon ----------------
    await s.shot("19c-world-before-salon");
    // A session that resumed indoors may never get CITIES_SNAPSHOT: fall back to the developer village list.
    await s.until(() => latest(s, ["CITIES_SNAPSHOT"]) !== null, 20_000, "cities snapshot").catch(() => undefined);
    const cities = ((latest(s, ["CITIES_SNAPSHOT"])?.cities ?? []) as any[]).filter((city) => city.controllerKind !== "npc");
    console.log("cities", cities.length, cities.slice(0, 3).map((city) => `${city.name}@${city.lat},${city.lon}`).join(" | "));
    let city = cities[0];
    if (!city) {
      const listMark = s.mark();
      await s.sendRaw({ type: "DEV_LIST_GOBLIN_VILLAGES" });
      await s.until(() => s.since(listMark, "DEV_GOBLIN_VILLAGES_SNAPSHOT", "in").length > 0 || s.since(listMark, "ERROR", "in").length > 0, 15_000, "village list");
      const list = s.since(listMark, "DEV_GOBLIN_VILLAGES_SNAPSHOT", "in")[0];
      console.log("villages", list?.raw.slice(0, 300));
      const village = list ? (JSON.parse(list.raw).villages as any[])[0] : null;
      if (village) city = { lat: Number(village.hallLat), lon: Number(village.hallLon) };
    }
    if (!city) {
      // No settlement authority in this runtime either: a developer Goblin Village is a city territory too.
      const villageMark = s.mark();
      await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
      for (let attempt = 0; attempt < 6; attempt++) {
        const attemptMark = s.mark();
        await s.sendRaw({ type: "DEV_SPAWN_GOBLIN_VILLAGE", lat: TEST_SPOT.lat + 0.004, lon: TEST_SPOT.lon });
        await s.until(() => s.since(attemptMark, "DEV_GOBLIN_VILLAGE_SPAWNED", "in").length > 0 || s.since(attemptMark, "ERROR", "in").length > 0, 60_000, "goblin village");
        const error = s.since(attemptMark, "ERROR", "in")[0];
        if (!error || !error.raw.includes("TRANSITION_PENDING")) break;
        console.log("village retry", error.raw.slice(0, 160), JSON.stringify(latest(s, ["PLAYER_LOCATION_SNAPSHOT"])?.location ?? null).slice(0, 200));
        await s.page.waitForTimeout(5000);
      }
      const spawned = s.since(villageMark, "DEV_GOBLIN_VILLAGE_SPAWNED", "in")[0];
      console.log("goblin village", spawned ? spawned.raw.slice(0, 400) : s.since(villageMark, "ERROR", "in")[0]?.raw);
      const village = spawned ? JSON.parse(spawned.raw) : null;
      const v = village?.village ?? village?.city ?? village;
      city = v ? { lat: Number(v.hallLat ?? v.lat), lon: Number(v.hallLon ?? v.lon) } : null;
    }
    expect(city, "a city to stand in").toBeTruthy();
    await s.teleport(city.lat - 120 / 111_320, city.lon);
    const salonMark = s.mark();
    await s.sendRaw({ type: "DEV_BUILD_SALON" });
    await s.until(() => s.since(salonMark, "CITY_FACILITY_CHANGED", "in").length > 0 || s.since(salonMark, "ERROR", "in").length > 0, 15_000, "dev salon result");
    const salonError = s.since(salonMark, "ERROR", "in")[0];
    expect(salonError ? salonError.raw : null, "DEV_BUILD_SALON succeeded").toBeNull();
    const salon = JSON.parse(s.since(salonMark, "CITY_FACILITY_CHANGED", "in")[0]!.raw).structure;
    console.log("salon", salon.structureId ?? salon.id, salon.lat, salon.lon);
    // Stand east of the Salon: the dev Greenhouse may sit just south of it and the player sprite would cover its roof.
    await s.teleport(salon.lat, salon.lon + 22 / 96_000);
    // Goblin Village mobs wander over the Salon sprite and take the map pick: clear them first.
    await s.clearMobs();
    await s.shot("20-overworld-near-salon");
    const enterSalon = s.page.getByRole("button", { name: "Enter Salon" });
    const salonOpened = await clickNear(s, await worldScreen(s.page, salon), enterSalon, [-40, -30, -50, -20, -60, 0]);
    expect(salonOpened, "the Salon prompt opens from a map pick").toBe(true);
    await enterSalon.click({ timeout: 10_000 });
    await s.until(() => latest(s, ["SALON_ENTERED"]) !== null, 15_000, "salon entered");
    await s.page.waitForTimeout(5000);
    await s.shot("21-salon-on-map-idle");
    expect(await s.page.locator(".salon-map-hud").count(), "the map-rendered Salon HUD mounts").toBeGreaterThan(0);
    expect(await s.page.locator(".salon-room").count(), "the DOM Salon stage is gone").toBe(0);
    expect(await s.page.locator(".joystick-move-base").count(), "the overworld stick is mounted in the Salon").toBeGreaterThan(0);
    const salonPos = (): { x: number; y: number } => {
      const p = latest(s, ["SALON_POSITION", "SALON_ENTERED"]);
      return p.position ?? p.session.position;
    };
    await walkChecks(s, "22-salon", salonPos, { x: 400, y: 600 });
    // Chair: a single map tap opens the Styling Chair prompt; Customize walks over and opens the editor.
    await s.page.mouse.click(...Object.values(await roomScreen(s.page, SALON_CHAIR)) as [number, number]);
    await s.page.waitForTimeout(800);
    await s.shot("25-salon-chair-prompt");
    const customize = s.page.getByRole("button", { name: "Customize Appearance" });
    expect(await customize.isVisible(), "the chair prompt opens from a map tap").toBe(true);
    await customize.click();
    await s.until(() => latest(s, ["SALON_EDITOR_OPENED"]) !== null, 15_000, "salon editor opened");
    await s.page.waitForTimeout(1500);
    await s.shot("26-salon-editor-open");
    const cancelMark = s.mark();
    await s.page.getByRole("button", { name: "Cancel styling" }).click({ timeout: 5000 }).catch(() => s.page.keyboard.press("Escape"));
    await s.until(() => s.since(cancelMark, "SALON_EDITOR_CANCELLED", "in").length > 0, 10_000, "salon editor cancelled");
    await s.page.waitForTimeout(1500);
    // Door: walk next to it (double-tap) so the camera brings it on screen, then tap -> Leave Salon.
    const nearDoor = await roomScreen(s.page, { x: 760, y: 700 });
    await s.page.mouse.dblclick(nearDoor.x, nearDoor.y);
    await s.page.waitForTimeout(3500);
    await s.page.mouse.click(...Object.values(await roomScreen(s.page, SALON_DOOR)) as [number, number]);
    await s.page.waitForTimeout(800);
    await s.shot("27-salon-door-prompt");
    const leave = s.page.getByRole("button", { name: "Leave Salon" });
    expect(await leave.isVisible(), "the door prompt opens from a map tap").toBe(true);
    await leave.click();
    await s.page.waitForTimeout(8000);
    await s.shot("28-overworld-after-salon");

    // ---------------- Greenhouse ----------------
    await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
    const grantMark = s.mark();
    await s.sendRaw({ type: "GRANT_OWN_DEV_ASSETS", materials: [
      { itemId: "wood", quantity: "200" }, { itemId: "iron_bar", quantity: "20" }, { itemId: "stone", quantity: "60" }
    ] });
    await s.until(() => s.since(grantMark, "DEV_ASSETS_GRANTED", "in").length > 0 || s.since(grantMark, "ERROR", "in").length > 0, 15_000, "dev grant");
    console.log("dev grant", (s.since(grantMark, "DEV_ASSETS_GRANTED", "in")[0] ?? s.since(grantMark, "ERROR", "in")[0])?.raw.slice(0, 200));
    // Seeds for the plot check, in their own grant (a seed the economy cannot grant must not block the build materials).
    const seedMark = s.mark();
    await s.sendRaw({ type: "GRANT_OWN_DEV_ASSETS", materials: [{ itemId: "giving_berry", quantity: "5" }] });
    await s.until(() => s.since(seedMark, "DEV_ASSETS_GRANTED", "in").length > 0 || s.since(seedMark, "ERROR", "in").length > 0, 15_000, "seed grant");
    console.log("seed grant", (s.since(seedMark, "DEV_ASSETS_GRANTED", "in")[0] ?? s.since(seedMark, "ERROR", "in")[0])?.raw.slice(0, 200));
    await s.page.waitForTimeout(2000);
    const owned = (latest(s, ["GREENHOUSES_SNAPSHOT"])?.greenhouses as any[] | undefined)?.find((g) => g.ownerPlayerId === s.self.id);
    if (!owned) {
      await openGreenhouseConstruction(s);
      await s.page.getByRole("button", { name: "Build Greenhouse" }).last().click({ timeout: 10_000 });
      await s.page.waitForTimeout(2500);
      await s.shot("30-greenhouse-build-prompt");
      const buildMark = s.mark();
      await s.page.locator(".game-action-prompt, [role='dialog']").getByRole("button", { name: "Build Greenhouse" }).last().click({ timeout: 10_000 });
      await s.until(() => s.since(buildMark, "GREENHOUSE_BUILD_RESULT", "in").length > 0 || s.since(buildMark, "GREENHOUSE_ERROR", "in").length > 0, 60_000, "greenhouse built");
      console.log("greenhouse build", JSON.stringify(s.since(buildMark).filter((f) => f.dir === "in").map((f) => f.type).slice(0, 30)));
      await s.page.waitForTimeout(2000);
    }
    await openGreenhouseConstruction(s);
    await s.shot("30b-greenhouse-construction-entry");
    await s.page.getByRole("button", { name: "Enter Greenhouse" }).last().click({ timeout: 10_000 });
    await s.until(() => latest(s, ["GREENHOUSE_STATE"]) !== null, 20_000, "greenhouse state");
    await s.page.waitForTimeout(6000);
    await s.shot("31-greenhouse-on-map-idle");
    expect(await s.page.locator(".greenhouse-map-hud").count(), "the map-rendered Greenhouse HUD mounts").toBeGreaterThan(0);
    expect(await s.page.locator(".greenhouse-room").count(), "the DOM Greenhouse stage is gone").toBe(0);
    const greenhousePos = (): { x: number; y: number } => latest(s, ["GREENHOUSE_POSITION"])?.position ?? { x: 627, y: 1000 };
    await walkChecks(s, "32-greenhouse", greenhousePos, { x: 627, y: 900 });
    // Plot: tap a placed farm plot -> its prompt; plant (and water) when seeds and art are available.
    // Mutation results carry the new state too (placing the tank answers with GREENHOUSE_MUTATION_RESULT only).
    const greenhouseState = (): any => {
      const f = latest(s, ["GREENHOUSE_STATE", "GREENHOUSE_MUTATION_RESULT"]);
      return f?.state ?? f;
    };
    const placedPlot = (): any => (greenhouseState().greenhouse.anchors as any[]).find((anchor) => anchor.placed !== false);
    if (!placedPlot() && Number(greenhouseState().gardeningBucketGallons ?? 0) < 1) {
      // A plot needs a gallon from the Gardening Bucket: place the tank (if needed) next to the player, then refill.
      if (!greenhouseState().greenhouse.waterStorage?.placed) {
        await s.page.getByRole("button", { name: /Place Water Tank/ }).first().click({ timeout: 5000 });
        await s.page.waitForTimeout(600);
        const tankAt = await roomScreen(s.page, { x: 760, y: 900 });
        await s.page.mouse.move(tankAt.x, tankAt.y, { steps: 6 });
        await s.page.mouse.click(tankAt.x, tankAt.y);
        await s.page.waitForTimeout(600);
        const tankMark = s.mark();
        await s.page.getByRole("button", { name: "Place Here" }).click({ timeout: 5000 }).catch(() => undefined);
        await s.until(() => (s.since(tankMark, "GREENHOUSE_STATE", "in").length > 0 || s.since(tankMark, "GREENHOUSE_MUTATION_RESULT", "in").length > 0) || s.since(tankMark, "GREENHOUSE_ERROR", "in").length > 0, 20_000, "tank placed").catch(() => undefined);
        console.log("tank placement", JSON.stringify(s.since(tankMark).filter((f) => f.dir === "in" && f.type.startsWith("GREENHOUSE")).map((f) => f.raw.slice(0, 160))));
        await s.page.waitForTimeout(1500);
      }
      const tank = greenhouseState().greenhouse.waterStorage;
      if (tank?.placed) {
        await s.page.mouse.click(...Object.values(await roomScreen(s.page, tank)) as [number, number]);
        await s.page.waitForTimeout(800);
        await s.shot("33-greenhouse-tank-prompt");
        const refill = s.page.getByRole("button", { name: "Refill Gardening Bucket" });
        if (await refill.isEnabled().catch(() => false)) {
          const refillMark = s.mark();
          await refill.click();
          await s.until(() => (s.since(refillMark, "GREENHOUSE_STATE", "in").length > 0 || s.since(refillMark, "GREENHOUSE_MUTATION_RESULT", "in").length > 0) || s.since(refillMark, "GREENHOUSE_ERROR", "in").length > 0, 20_000, "bucket refilled").catch(() => undefined);
          await s.page.waitForTimeout(4000);
          console.log("refill", JSON.stringify(s.since(refillMark).filter((f) => f.dir === "in" && f.type.startsWith("GREENHOUSE")).map((f) => f.raw.slice(0, 160))), "bucket", greenhouseState().gardeningBucketGallons);
        } else {
          await s.page.keyboard.press("Escape");
        }
      }
    }
    if (!placedPlot()) {
      // A fresh Greenhouse has no plots: place one through the map placement flow (wood + fertilizer + 1 gallon).
      const fertMark = s.mark();
      await s.sendRaw({ type: "GRANT_OWN_DEV_ASSETS", materials: [{ itemId: "wood", quantity: "100" }, { itemId: "fertilizer", quantity: "50" }] });
      await s.until(() => s.since(fertMark, "DEV_ASSETS_GRANTED", "in").length > 0 || s.since(fertMark, "ERROR", "in").length > 0, 15_000, "fertilizer grant");
      console.log("fertilizer grant", (s.since(fertMark, "DEV_ASSETS_GRANTED", "in")[0] ?? s.since(fertMark, "ERROR", "in")[0])?.raw.slice(0, 160));
      await s.page.getByRole("button", { name: /Place Farm Plot/ }).first().click({ timeout: 5000 });
      await s.page.waitForTimeout(600);
      const plotAt = await roomScreen(s.page, { x: 520, y: 760 });
      await s.page.mouse.move(plotAt.x, plotAt.y, { steps: 6 });
      await s.page.waitForTimeout(600);
      await s.shot("34-greenhouse-plot-placement-preview");
      await s.page.mouse.click(plotAt.x, plotAt.y);
      await s.page.waitForTimeout(600);
      const placeHere = s.page.getByRole("button", { name: "Place Here" });
      if (await placeHere.isEnabled().catch(() => false)) {
        const placeMark = s.mark();
        await placeHere.click();
        await s.until(() => (s.since(placeMark, "GREENHOUSE_STATE", "in").length > 0 || s.since(placeMark, "GREENHOUSE_MUTATION_RESULT", "in").length > 0) || s.since(placeMark, "GREENHOUSE_ERROR", "in").length > 0, 20_000, "plot placed");
        console.log("plot placement", JSON.stringify(s.since(placeMark).filter((f) => f.dir === "in" && f.type.startsWith("GREENHOUSE")).map((f) => f.raw.slice(0, 160))));
        await s.page.waitForTimeout(1500);
      } else {
        console.log("plot placement unavailable", await s.page.locator(".game-action-prompt").first().innerText().catch(() => ""));
        await s.page.keyboard.press("Escape");
        await s.page.waitForTimeout(400);
      }
    }
    const plot = placedPlot();
    if (plot) {
      await s.page.mouse.click(...Object.values(await roomScreen(s.page, plot)) as [number, number]);
      await s.page.waitForTimeout(800);
      await s.shot("35-greenhouse-plot-prompt");
      expect(await s.page.locator(".game-action-prompt h2, .game-action-prompt [role='heading'], [role='heading']").filter({ hasText: /Farm Plot/ }).count(),
        "the plot prompt opens from a map tap").toBeGreaterThan(0);
      const plant = s.page.getByRole("button", { name: /^Plant/ }).first();
      if (await plant.isEnabled().catch(() => false)) {
        const plantMark = s.mark();
        await plant.click();
        await s.until(() => s.since(plantMark, "GREENHOUSE_MUTATION_RESULT", "in").length > 0 || s.since(plantMark, "GREENHOUSE_ERROR", "in").length > 0, 20_000, "plant result");
        await s.page.waitForTimeout(1500);
        await s.shot("36-greenhouse-planted");
        console.log("plant", JSON.stringify(s.since(plantMark).filter((f) => f.dir === "in").map((f) => f.type)));
      } else {
        console.log("plant unavailable", await plant.getAttribute("aria-disabled").catch(() => null));
        await s.page.keyboard.press("Escape");
      }
    } else {
      console.log("no placed farm plot in this greenhouse");
    }
    // Placement preview: Place Farm Plot / Move Water Tank -> capture layer -> preview follows the pointer.
    const placeTank = s.page.getByRole("button", { name: /Water Tank/ }).first();
    await placeTank.click();
    await s.page.waitForTimeout(800);
    expect(await s.page.locator("[data-greenhouse-placement-capture]").count(), "placement runs over the map").toBe(1);
    const previewAt = await roomScreen(s.page, { x: 380, y: 700 });
    await s.page.mouse.move(previewAt.x, previewAt.y, { steps: 6 });
    await s.page.waitForTimeout(800);
    await s.shot("37-greenhouse-placement-preview");
    await s.page.mouse.click(previewAt.x, previewAt.y);
    await s.page.waitForTimeout(800);
    await s.shot("38-greenhouse-placement-confirm");
    expect(await s.page.getByRole("button", { name: "Place Here" }).isVisible(), "the placement confirmation opens").toBe(true);
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(500);
    // Same room, map renderer vs the old DOM stage (developer legacy switch), for the rotation/scale comparison.
    await s.page.mouse.dblclick(...Object.values(await roomScreen(s.page, { x: 627, y: 600 })) as [number, number]);
    await s.page.waitForTimeout(3500);
    await s.shot("39-greenhouse-map-compare");
    await s.page.locator("button.developer-tools-trigger").evaluate((el: HTMLElement) => el.click());
    await s.page.getByRole("tab", { name: /Developer View/ }).or(s.page.getByRole("button", { name: /Developer View/ })).first().click({ timeout: 10_000 });
    await s.page.getByLabel(/Use legacy indoor dungeon scene/).check({ timeout: 10_000 });
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(4000);
    await s.shot("40-greenhouse-legacy-dom-compare");
    expect(await s.page.locator(".greenhouse-room, .greenhouse-scene").count(), "the legacy switch shows the DOM Greenhouse").toBeGreaterThan(0);
    // The legacy switch is session-only; closing the browser resets it.
  } finally {
    await browser.close();
  }
});
