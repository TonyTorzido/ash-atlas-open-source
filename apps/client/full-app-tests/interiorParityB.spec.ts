/**
 * Interior parity phase B evidence: a dev manor (Developer App "Grant dev manor here" message) with the overworld stick, and the
 * dungeon camera keeping the player centred.
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=<dir> pnpm exec playwright test --config playwright-full-app.config.ts interiorParityB
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, chromium } from "@playwright/test";

import { launch, TEST_SPOT, type Session } from "./e2eSession.js";

const locRevision = (frames: { dir: string; raw: string }[]): number => {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
    try {
      const rev = JSON.parse(f.raw).location?.revision;
      if (typeof rev === "number") return rev;
    } catch { /* not json */ }
  }
  return 0;
};

async function leaveInteriorAndTeleport(s: Session): Promise<void> {
  await s.page.waitForTimeout(4000);
  const dungeon = [...s.frames].reverse().find((f) => f.dir === "in" && f.type === "DUNGEON_SNAPSHOT");
  if (dungeon) {
    const snap = JSON.parse(dungeon.raw).snapshot;
    const exit = snap.objects.find((o: any) => o.portalId && /exit|world/i.test(o.portalId)) ?? snap.objects.find((o: any) => o.portalId);
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: snap.sessionId, x: exit.x, y: exit.y });
    await s.page.waitForTimeout(6000);
    await s.sendRaw({ type: "USE_PORTAL", portalId: exit.portalId, expectedLocationRevision: locRevision(s.frames) });
    await s.page.waitForTimeout(6000);
  }
  // A session that resumed inside the manor (an earlier run) walks out through its main door first.
  const location = [...s.frames].reverse().find((f) => f.dir === "in" && f.type === "PLAYER_LOCATION_SNAPSHOT");
  const loc = location ? JSON.parse(location.raw).location : null;
  if (loc?.locationType === "manor") {
    await s.sendRaw({ type: "USE_PORTAL", portalId: `manor:${loc.locationId}:main-to-world`, expectedLocationRevision: locRevision(s.frames) });
    await s.page.waitForTimeout(6000);
  }
  await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
}

const hud = (s: Session): Promise<Record<string, number>> => s.page.evaluate(() => ({
  joystick: document.querySelectorAll("[class*='joystick' i]").length,
  offscreen: document.querySelectorAll("[class*='offscreen' i]").length
}));

// Manor rooms on the main map renderer (INTERIOR_MAP_RENDERER.md P4): room units -> map lngLat, as interiorSpace.ts does.
const MANOR_METERS_PER_UNIT = 125 / 260;
const METERS_PER_DEGREE = 2 * Math.PI * 6_371_008.8 / 360;
const manorLngLat = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x * MANOR_METERS_PER_UNIT / METERS_PER_DEGREE,
  lat: -p.y * MANOR_METERS_PER_UNIT / METERS_PER_DEGREE
});
const manorScreen = (s: Session, p: { x: number; y: number }): Promise<{ x: number; y: number }> =>
  s.page.evaluate(({ lng, lat }) => {
    const at = (window as any).__e2eMap.project([lng, lat]);
    return { x: at.x as number, y: at.y as number };
  }, manorLngLat(p));
const manorLobby = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../packages/shared/src/data/interiors/manor_lobby.json", import.meta.url)), "utf8"
));

test("dev manor: drawn by the map, entered, keys/stick/double-tap walk it, the camera follows, doors and decorations work", async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "interior-parity-b", { joystick: true, skipTeleport: true });
  try {
    await leaveInteriorAndTeleport(s);
    await s.shot("10-overworld-before-manor");
    const mark = s.mark();
    await s.sendRaw({ type: "DEV_BUILD_MANOR" });
    await s.until(() => s.since(mark, "MANOR_BUILD_RESULT", "in").length > 0 || s.since(mark, "ERROR", "in").length > 0, 15_000, "manor build result");
    const built = s.since(mark, "MANOR_BUILD_RESULT", "in")[0];
    // An earlier run already built the manor: take its id from the status frame instead.
    const status = [...s.frames].reverse().find((f) => f.dir === "in" && (f.type === "MANOR_STATUS" || f.type === "MANOR_BUILD_RESULT"));
    const manor = JSON.parse((built ?? status)!.raw).manor;
    console.log("manor", manor.manorId ?? manor.id, manor.typeId ?? manor.manorTypeId ?? "default type");
    await s.page.waitForTimeout(2000);
    const enter = s.mark();
    // Enter through the client (map pick -> Manor prompt -> Enter Manor): the client only adopts a MANOR_ENTERED that answers
    // its own entry request, so a raw USE_PORTAL from the spec left the room blank (location interior, no manor session).
    await s.teleport(manor.lat - 18 / 111_320, manor.lon);
    const enterButton = s.page.getByRole("button", { name: "Enter Manor" });
    await s.page.waitForTimeout(2500);
    await s.shot("10b-overworld-near-manor");
    let opened = false;
    for (const dy of [-30, -50, -15, -70, 0, -90, 15]) {
      const at = await s.page.evaluate(({ lat, lon }) => { const p = (window as any).__e2eMap.project([lon, lat]); return { x: p.x as number, y: p.y as number }; }, { lat: manor.lat, lon: manor.lon });
      await s.page.mouse.click(at.x, at.y + dy);
      await s.page.waitForTimeout(700);
      opened = await enterButton.isVisible().catch(() => false);
      console.log("manor pick at", Math.round(at.x), Math.round(at.y + dy), opened);
      if (opened) break;
      await s.page.keyboard.press("Escape");
      await s.page.waitForTimeout(300);
    }
    expect(opened, "the Manor prompt opens from a map pick").toBe(true);
    await enterButton.click({ timeout: 10_000 });
    await s.page.waitForTimeout(9000);
    console.log("enter frames", JSON.stringify([...new Set(s.since(enter).filter((f) => f.dir === "in").map((f) => f.type))].slice(0, 40)));
    await s.shot("11-manor-on-map-idle");
    const manorHud = await hud(s);
    console.log("HUD manor", JSON.stringify(manorHud));
    expect(await s.page.locator(".manor-map-hud").count(), "the map-rendered Manor HUD mounts").toBeGreaterThan(0);
    expect(await s.page.locator(".manor-floor-art").count(), "the DOM Manor stage is gone").toBe(0);
    expect(manorHud.joystick, "the overworld stick is mounted in the manor").toBeGreaterThan(0);
    const posOf = (): any => {
      const f = [...s.frames].reverse().find((x) => x.dir === "in" && x.type === "MANOR_POSITION");
      if (f) return JSON.parse(f.raw).position;
      const entered = [...s.frames].reverse().find((x) => x.dir === "in" && x.type === "MANOR_ENTERED");
      return entered ? JSON.parse(entered.raw).position : null;
    };
    const viewport = s.page.viewportSize()!;
    const offCentre = async (): Promise<number> => {
      const p = posOf();
      const at = await manorScreen(s, p);
      return Math.hypot(at.x - viewport.width / 2, at.y - viewport.height / 2) / Math.min(viewport.width, viewport.height);
    };
    // Keys (the joystick's keyboard path), timed for the walk speed: 260 room units per second (125 m/s).
    const before = posOf();
    await s.page.keyboard.down("a");
    const keysStart = Date.now();
    await s.page.waitForTimeout(900);
    await s.shot("12-manor-walking-keys-centred");
    const centredWhileWalking = await offCentre();
    await s.page.keyboard.up("a");
    const keysHeldMs = Date.now() - keysStart;
    await s.page.waitForTimeout(1200);
    const afterKeys = posOf();
    const keysUnits = Math.hypot(afterKeys.x - before.x, afterKeys.y - before.y);
    console.log("manor keys", JSON.stringify(before), "->", JSON.stringify(afterKeys), "units", Math.round(keysUnits),
      "held ms", keysHeldMs, "units/s", Math.round(keysUnits / (keysHeldMs / 1000)), "off-centre", centredWhileWalking.toFixed(3));
    expect(afterKeys.x, "keys walk the manor west").toBeLessThan(before.x - 60);
    expect(keysUnits / (keysHeldMs / 1000), "no faster than 260 u/s (125 m/s) plus input lead").toBeLessThan(260 * 1.35);
    expect(centredWhileWalking, "the camera keeps the player near the centre while walking").toBeLessThan(0.2);
    // Stick: drag the on-screen stick upward.
    const stick = s.page.locator(".joystick-move-base").first();
    const box = await stick.boundingBox();
    expect(box, "the stick is on screen").not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await s.page.mouse.move(cx, cy);
    await s.page.mouse.down();
    await s.page.mouse.move(cx, cy - 40, { steps: 6 });
    await s.page.waitForTimeout(900);
    await s.shot("13-manor-walking-stick");
    await s.page.mouse.up();
    await s.page.waitForTimeout(800);
    const afterStick = posOf();
    console.log("manor stick", JSON.stringify(afterKeys), "->", JSON.stringify(afterStick));
    expect(afterStick.y, "the stick walks the manor north").toBeLessThan(afterKeys.y - 20);
    // Double-tap the map floor (a single tap only selects, like the overworld).
    const tapTarget = { x: 627, y: 760 };
    const tapAt = await manorScreen(s, tapTarget);
    await s.page.mouse.dblclick(tapAt.x, tapAt.y);
    await s.page.waitForTimeout(3000);
    const afterTap = posOf();
    console.log("manor double-tap", JSON.stringify(afterStick), "->", JSON.stringify(afterTap));
    await s.shot("14-manor-after-double-tap");
    expect(Math.hypot(afterTap.x - afterStick.x, afterTap.y - afterStick.y), "a map double-tap walks the manor").toBeGreaterThan(20);

    // Decorations: menu -> place -> drag on the map -> confirm.
    await s.page.getByRole("button", { name: "Decorations" }).click();
    await s.page.waitForTimeout(1500);
    await s.shot("15-manor-decorations-menu");
    const placeChoice = s.page.locator(".manor-decoration-menu-choice:not([disabled])").filter({ hasText: "Place" }).first();
    const canPlace = await placeChoice.count() > 0;
    console.log("decoration place available", canPlace);
    if (canPlace) {
      await placeChoice.click();
      await s.page.waitForTimeout(800);
      expect(await s.page.locator("[data-manor-placement-capture]").count(), "placement drags over the map").toBe(1);
      const from = await manorScreen(s, { x: 560, y: 820 });
      await s.page.mouse.move(from.x, from.y);
      await s.page.mouse.down();
      await s.page.mouse.move(from.x + 40, from.y + 20, { steps: 8 });
      await s.shot("16-manor-decoration-preview-dragging");
      await s.page.mouse.up();
      await s.page.waitForTimeout(600);
      const yes = s.page.getByRole("button", { name: "Yes" });
      expect(await yes.isVisible(), "the placement confirmation opens").toBe(true);
      const placeMark = s.mark();
      await yes.click();
      await s.until(() => s.since(placeMark, "MANOR_DECORATION_UPDATED", "in").length > 0 ||
        s.since(placeMark, "ERROR", "in").length > 0, 10_000, "decoration result");
      console.log("decoration result", JSON.stringify(s.since(placeMark).filter((f) => f.dir === "in").map((f) => f.type)));
      await s.page.waitForTimeout(1500);
      await s.shot("17-manor-decoration-placed");
      expect(s.since(placeMark, "MANOR_DECORATION_UPDATED", "in").length, "the server accepted the placement").toBeGreaterThan(0);
    } else {
      await s.page.keyboard.press("Escape");
    }
    // The dev manor's only decoration is the authored bed (template default, not movable): placement on the map is then
    // covered by ManorUi.test.tsx ("map-rendered: drags the placement preview ...").
    await s.page.getByRole("button", { name: "Close" }).click({ timeout: 3000 }).catch(() => undefined);

    // Doors: tap an authored door hotspot of the lobby on the map, use it, and arrive in the next room.
    const lobby = manorLobby.rooms.find((room: any) => room.id === manorLobby.defaultRoomId);
    const doorArea = lobby.clickAreas.find((area: any) => !area.retired && area.target?.anchorId &&
      manorLobby.portals.some((portal: any) => !portal.retired && portal.enabled && portal.destination.kind === "room" &&
        portal.source.kind === "room" && portal.source.roomId === lobby.id && portal.source.anchorId === area.target.anchorId));
    expect(doorArea, "the lobby has an authored door").toBeTruthy();
    const centroid = doorArea.polygon.reduce((sum: any, p: any) => ({ x: sum.x + p.x / doorArea.polygon.length, y: sum.y + p.y / doorArea.polygon.length }), { x: 0, y: 0 });
    // Bring the door into view first (zoomed-out camera on the room centre).
    await s.page.evaluate(({ lng, lat }) => (window as any).__e2eMap.jumpTo({ center: [lng, lat], zoom: 16.5 }), manorLngLat({ x: 627, y: 627 }));
    await s.page.waitForTimeout(600);
    const doorAt = await manorScreen(s, centroid);
    await s.page.mouse.click(doorAt.x, doorAt.y);
    await s.page.waitForTimeout(900);
    await s.shot("18-manor-door-prompt");
    const doorAction = s.page.locator(".game-compact-action button").first();
    expect(await doorAction.isVisible(), `the door prompt opens (${doorArea.interactionLabel})`).toBe(true);
    const doorMark = s.mark();
    await doorAction.click();
    await s.until(() => s.since(doorMark, "MANOR_ENTERED", "in").length > 0 ||
      s.since(doorMark, "PLAYER_LOCATION_SNAPSHOT", "in").some((f) => !/manor_main_room|manor_lobby_room/.test(JSON.parse(f.raw).location?.spaceId ?? "manor_main_room")),
      25_000, "next room");
    await s.page.waitForTimeout(4000);
    await s.shot("19-manor-next-room-on-map");
    expect(await s.page.locator(".manor-map-hud").count(), "the next room is map-rendered too").toBeGreaterThan(0);
  } finally {
    s.save();
    await browser.close();
  }
});

test("drowned city: the camera keeps the player in view after a long walk and a dash", async () => {
  test.setTimeout(240_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "interior-parity-b-city", { joystick: true, skipTeleport: true });
  try {
    await leaveInteriorAndTeleport(s);
    await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:drowned_city", lat: s.self.lat + 0.00008, lon: s.self.lon });
    await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance spawned");
    const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
    await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s.frames) });
    await s.until(() => s.frames.some((f) => f.type === "DUNGEON_SNAPSHOT"), 30_000, "dungeon snapshot");
    await s.page.waitForTimeout(6000);
    const snapshot = (): any => JSON.parse([...s.frames].reverse().find((f) => f.dir === "in" && f.type === "DUNGEON_SNAPSHOT")!.raw).snapshot;
    const offset = (): Promise<number | null> => s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__?.playerOffsetPx ?? null);
    await s.shot("13-city-enter");
    console.log("offset at enter", await offset());
    // Hold a key (the joystick keyboard path) for a long walk toward the room's far side: sample the camera offset the whole way.
    const walkSamples: number[] = [];
    const startOffset = await offset();
    const room = snapshot();
    const walkKey = room.player.x > room.roomWidth / 2 ? "a" : "d";
    const startPos = { x: room.player.x, y: room.player.y };
    const center = (): Promise<{ lng: number; lat: number }> => s.page.evaluate(() => { const c = (window as any).__e2eMap.getCenter(); return { lng: c.lng as number, lat: c.lat as number }; });
    const centerBefore = await center();
    await s.page.keyboard.down(walkKey);
    for (let i = 0; i < 12; i++) {
      await s.page.waitForTimeout(250);
      const o = await offset();
      if (o !== null) walkSamples.push(Math.round(o));
      if (i === 2) await s.shot("14-city-walking-centred");
    }
    await s.page.keyboard.up(walkKey);
    await s.page.waitForTimeout(1500);
    const endPos = snapshot().player;
    const centerAfter = await center();
    const walkedUnits = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);
    const cameraMovedM = Math.hypot((centerAfter.lng - centerBefore.lng) * 111_320, (centerAfter.lat - centerBefore.lat) * 111_320);
    console.log("city offset start", startOffset, "walk", walkKey, "samples", JSON.stringify(walkSamples),
      "player", JSON.stringify(startPos), "->", JSON.stringify({ x: endPos.x, y: endPos.y }), "walked units", Math.round(walkedUnits),
      "camera moved m", Math.round(cameraMovedM));
    expect(walkedUnits, "the keys walk the player across the room").toBeGreaterThan(150);
    expect(cameraMovedM, "the camera travelled with the player").toBeGreaterThan(20);
    await s.shot("15-city-after-walk");
    await s.page.keyboard.down("s");
    const downSamples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await s.page.waitForTimeout(250);
      const o = await offset();
      if (o !== null) downSamples.push(Math.round(o));
    }
    await s.page.keyboard.up("s");
    console.log("city offset walking south", JSON.stringify(downSamples));
    await s.page.keyboard.down("a");
    await s.page.keyboard.press("Space");
    await s.page.waitForTimeout(500);
    await s.page.keyboard.up("a");
    await s.page.waitForTimeout(2500);
    const finalOffset = await offset();
    console.log("offset after dash", finalOffset);
    await s.shot("16-city-after-dash");
    expect(walkSamples.length).toBeGreaterThan(6);
    // While walking the player stays near the screen centre (the follow's soft frame), and settles there after the dash.
    expect(Math.max(...walkSamples.slice(2)), "player near centre while walking").toBeLessThan(160);
    expect(finalOffset).not.toBeNull();
    expect(finalOffset!).toBeLessThan(160);
  } finally {
    s.save();
    await browser.close();
  }
});
