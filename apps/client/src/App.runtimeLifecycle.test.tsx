// @vitest-environment jsdom

import {
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CATALOG,
  dungeonLocalToCombatPosition,
  emptyEquipmentSlots,
  emptyInventoryTotals,
  type DroppedItemSnapshot,
  type DungeonEntranceSnapshot,
  type DungeonSnapshot,
  type DungeonSnapshotUpdate,
  type PlayerInventorySnapshot,
  type MilitaryUnitGroupSnapshot,
  type MilitaryUnitSnapshot,
  type ServerMessage
} from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as startupState from "./startupState.js";

vi.hoisted(() => {
  window.URL.createObjectURL = vi.fn(() => "blob:maplibre-worker");
  window.URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: "",
    globalCompositeOperation: "source-over",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) }))
  })) as never;
});

const worldMapRenderStates = vi.hoisted(() => [] as boolean[]);

vi.mock("./ui/WorldMapOverlay.js", () => ({
  WorldMapOverlay: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    worldMapRenderStates.push(open);
    return open
      ? <div role="dialog" aria-label="World Map">
          <button type="button" onClick={onClose}>Close World Map</button>
        </div>
      : null;
  }
}));

import {
  GameApp,
  type GameRuntimeFactories
} from "./App.js";
import type { AuthenticatedClientSession } from "./auth/authState.js";
import type { CombatStore } from "./combat/combatStore.js";
import type { GameClient, GameClientHandlers } from "./gameClient.js";
import type { GameMapRuntime, MapRuntimeHandlers } from "./map/mapRuntime.js";
import type { PixiGameOverlay } from "./map/pixiOverlay.js";
import { PlayerRenderTimeline } from "./movement/playerRenderSmoothing.js";
import type { GameRuntimeLifecycleEvent } from "./runtimeLifecycleInstrumentation.js";
import { UiEnvironmentProvider } from "./uiEnvironment.js";
import { addPlanningAnchor, EMPTY_PLANNING_ANCHORS } from "./map/planningAnchors.js";

const playerOneSession: AuthenticatedClientSession = {
  authenticated: true,
  csrfToken: "csrf",
  developmentAuthEnabled: true,
  developerCapabilities: [],
  testAccessStatus: "approved" as const,
  account: { id: "account-1", status: "active" as const, trustTier: "standard" as const },
  player: { id: "player-1", displayName: "Scout", personalFlagColor: "blue" as const },
  onboardingRequired: false
};

function mockGameplayReady(): void {
  vi.spyOn(startupState, "isStartupPresentationReady").mockReturnValue(true);
  vi.spyOn(startupState, "isCurrentWorldPresentation").mockReturnValue(true);
}

describe("GameApp runtime ownership", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 390,
        bottom: 844,
        width: 390,
        height: 844,
        toJSON: () => ({})
      })
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
  });

  afterEach(() => {
    cleanup();
    worldMapRenderStates.length = 0;
    vi.useRealTimers();
    delete window.__ASH_ATLAS_RUNTIME_LIFECYCLE_OBSERVER__;
    delete window.__ASH_ATLAS_FLAG_TRAVEL_PRESENTATION_OBSERVER__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a history retry contained after the authenticated-mount announcement fetch fails", async () => {
    let announcementRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("/api/announcements")) {
        announcementRequests += 1;
        if (announcementRequests === 1) {
          return new Response(JSON.stringify({ error: { message: "Temporarily unavailable" } }), {
            status: 503,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ announcements: [{
          id: "22222222-2222-4222-8222-222222222222",
          title: "History Only",
          message: "This retry stays in Support.",
          publishedAt: "2026-08-31T12:00:00.000Z"
        }], latestAnnouncementId: "22222222-2222-4222-8222-222222222222", latestAnnouncementDismissed: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);

    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(announcementRequests).toBe(1));
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());
    expect(screen.queryByRole("region", { name: "Player announcement" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open Game Menu/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Notice Board" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Announcements" }));
    await screen.findByRole("heading", { name: "History Only" });

    expect(announcementRequests).toBe(2);
    expect(screen.queryByRole("region", { name: "Player announcement" })).toBeNull();
    view.unmount();
  });

  it("shows pushed announcements immediately and persists nonblocking Close", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/announcements")) {
        requests.push({ url, ...(init ? { init } : {}) });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({
            announcementId: "33333333-3333-4333-8333-333333333333",
            dismissed: true,
            dismissedAt: "2026-09-01T14:00:00.000Z"
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          announcements: [], latestAnnouncementId: null, latestAnnouncementDismissed: false
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(requests).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    act(() => harness.message({
      type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
      announcement: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "First live notice",
        message: "First message",
        publishedAt: "2026-09-01T12:00:00.000Z"
      }
    }));
    const firstNotice = await screen.findByRole("region", { name: "Player announcement" });
    expect(firstNotice.closest(".announcement-global-hud-layer")).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: /announcement/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open Game Menu/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Notice Board" }));
    expect(await screen.findByRole("tab", { name: "Announcements" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Player announcement" })).toBeTruthy();

    act(() => harness.message({
      type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
      announcement: {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Replacement live notice",
        message: "Replacement message",
        publishedAt: "2026-09-01T13:00:00.000Z"
      }
    }));
    const notice = await screen.findByRole("region", { name: "Player announcement" });
    expect(within(notice).getByRole("heading", { name: "Replacement live notice" })).toBeTruthy();
    expect(within(notice).queryByText("First live notice")).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toMatchObject({
      url: expect.stringContaining("/api/announcements/33333333-3333-4333-8333-333333333333/dismiss"),
      init: {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: expect.objectContaining({ "x-csrf-token": "csrf" })
      }
    });
    expect(screen.queryByRole("region", { name: "Player announcement" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Announcements" })).toBeTruthy();

    act(() => harness.message({
      type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
      announcement: {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Replacement live notice",
        message: "Replacement message",
        publishedAt: "2026-09-01T13:00:00.000Z"
      }
    }));
    expect(screen.queryByRole("region", { name: "Player announcement" })).toBeNull();

    act(() => harness.message({
      type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
      announcement: {
        id: "44444444-4444-4444-8444-444444444444",
        title: "Newest live notice",
        message: "Newest message",
        publishedAt: "2026-09-01T14:00:00.000Z"
      }
    }));
    const newestAnnouncement = await screen.findByRole("region", { name: "Player announcement" });
    expect(within(newestAnnouncement).getByRole("heading", { name: "Newest live notice" })).toBeTruthy();
    view.unmount();
  });

  it("keeps map, Pixi, and client instances stable across authoritative inventory changes", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);

    await waitFor(() => expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "pixi-overlay-created": 1,
      "game-client-created": 1,
      "game-client-connected": 1
    }));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    act(() => {
      for (let sequence = 0; sequence < 100; sequence += 1) {
        harness.message(playerResourcesUpdated(inventoryWithLeather(sequence)));
        harness.message(protectionSnapshot(sequence));
      }
      harness.message(devGrant(inventoryWithLeather(40, 100)));
      harness.message(itemDrop(inventoryWithLeather(50, 101)));
      harness.message(pickupResult(inventoryWithLeather(60, 102), 5, 7));
      harness.message(pickupResult(inventoryWithLeather(65, 103), 2, 5));
      harness.message(packageClaim(inventoryWithLeather(68, 104)));
      harness.message(marketMutation(105));
    });
    expect(harness.latestInventorySnapshot()?.totals.leather).toBe(70);

    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 0,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });

    const latest = inventoryWithLeather(83, 106);
    const drop = leatherDrop(500);
    act(() => {
      harness.message(playerResourcesUpdated(latest));
      harness.message({
        type: "DROPPED_ITEMS_SNAPSHOT",
        drops: [drop],
        serverTime: 1
      });
      harness.selectDrop(drop);
    });
    expect(harness.latestInventorySnapshot()?.totals.leather).toBe(83);
    expect(harness.latestPickupRecommendation()).toBe(500);
    act(() => {
      harness.message(playerResourcesUpdated(inventoryWithLeather(0, 1)));
    });
    expect(harness.latestInventorySnapshot()?.totals.leather).toBe(83);

    view.unmount();
    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 1,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 1,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 1
    });
  });

  it("keeps map, Pixi, and client instances stable across dungeon snapshot updates", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);

    await waitFor(() => expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "pixi-overlay-created": 1,
      "game-client-created": 1,
      "game-client-connected": 1
    }));

    act(() => harness.message(dungeonSnapshotUpdate()));

    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 0,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });

    view.unmount();
  });

  it("uses canonical dungeon combat actions and clears cancelled, defeated, and stale selections", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["game-client-connected"]).toBe(1));
    const room = CISTERN_WARRENS_DUNGEON.rooms[0]!;
    const snapshot = {
      ...CISTERN_WARRENS_DUNGEON, snapshotKind: "full", sessionId: "session-1",
      instanceId: "sewer:1", spaceId: room.id, room, prefabs: DUNGEON_CATALOG.prefabs,
      roomWidth: room.width, roomHeight: room.height, playerVisualHeight: 52.5, camera: room.camera,
      environment: CISTERN_WARRENS_DUNGEON.environment,
      player: { playerId: "player-1", name: "Player", x: 100, y: 100, currentHealth: 100,
        maxHealth: 100, movementSpeed: 195, movementRevision: 1, targetX: null, targetY: null },
      occupants: [], objects: [], portalLocks: {}, encounters: [], telegraphs: [], triggers: [],
      dungeonFlags: {}, cues: [], status: "Active", serverTime: 1,
      enemies: [{ entityId: "sewer-goblin", spawnId: "spawn-1", encounterId: "encounter-1",
        archetype: "goblin", name: "Sewer Goblin", x: 200, y: 200, currentHealth: 10,
        maxHealth: 10, lifeState: "alive", targetEntityId: null, visualScale: 1 }]
    } as unknown as DungeonSnapshot;
    act(() => {
      harness.open();
      harness.message(welcomeWithWallet("0", "1"));
      harness.message({ type: "PROGRESSION_SNAPSHOT", progression: {
        playerId: "player-1", totalXp: 0, level: 1, curveVersion: 1, persistenceVersion: 1,
        xpIntoLevel: 0, xpForNextLevel: 100, nextLevelTotalXp: 100, atCap: false,
        pveStats: { maxHealth: 100, attackPower: 10, defense: 0 }
      } } as ServerMessage);
      harness.message({ type: "PLAYER_LOCATION_SNAPSHOT", location: {
        kind: "interior", locationType: "cistern_warrens", locationId: "sewer-1",
        instanceId: snapshot.instanceId, spaceId: room.id,
        position: { x: 100, y: 100 }, revision: 2
      } } as ServerMessage);
      harness.message({ type: "DUNGEON_ENTERED", snapshot: { ...snapshot } } as ServerMessage);
    });
    // The room draws through the map renderer; the DOM scene is replaced by a hidden ready marker.
    await waitFor(() => expect(document.querySelector("[data-map-rendered-interior]")).not.toBeNull());
    act(() => harness.message(dungeonCombatSnapshot()));
    act(() => harness.selectDungeonEnemy("sewer-goblin"));
    expect(harness.startAttack).not.toHaveBeenCalled();
    const promptName = "Sewer Goblin · Common · Lv 1 actions";
    let prompt = screen.getByRole("complementary", { name: promptName });
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("complementary", { name: promptName })).toBeNull();
    act(() => harness.selectDungeonEnemy("sewer-goblin"));
    prompt = screen.getByRole("complementary", { name: promptName });
    fireEvent.click(within(prompt).getByRole("button", { name: "Attack" }));
    expect(harness.startAttack).toHaveBeenCalledWith("sewer-goblin", false);
    expect(screen.queryByRole("complementary", { name: promptName })).toBeNull();
    act(() => harness.selectDungeonEnemy("sewer-goblin"));
    act(() => harness.message(dungeonCombatSnapshot({ enemyHealth: 0, enemyLifeState: "defeated" })));
    expect(screen.queryByRole("complementary", { name: promptName })).toBeNull();
    act(() => harness.message(dungeonCombatSnapshot({ includeEnemy: false })));
    expect(screen.queryByRole("complementary", { name: promptName })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sewer Goblin" })).toBeNull();
    act(() => harness.message(dungeonCombatSnapshot()));
    act(() => harness.selectDungeonEnemy("sewer-goblin"));
    act(() => harness.message(dungeonCombatSnapshot({ playerHealth: 0 })));
    expect(screen.queryByRole("button", { name: "Attack" })).toBeNull();
    expect(harness.startAttack).toHaveBeenCalledOnce();
    act(() => harness.message(dungeonCombatSnapshot({ includeEnemy: false })));
    expect(screen.queryByRole("complementary", { name: promptName })).toBeNull();
    view.unmount();
  });

  it("finishes startup for a persisted greenhouse after its authoritative state arrives", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["game-client-connected"]).toBe(1));

    act(() => {
      harness.open();
      harness.message(welcomeWithWallet("0", "1"));
      harness.message({ type: "PROGRESSION_SNAPSHOT", progression: {
        playerId: "player-1", totalXp: 0, level: 1, curveVersion: 1, persistenceVersion: 1,
        xpIntoLevel: 0, xpForNextLevel: 100, nextLevelTotalXp: 100, atCap: false,
        pveStats: { maxHealth: 100, attackPower: 10, defense: 0 }
      } } as ServerMessage);
      harness.message(greenhouseInteriorLocation());
      harness.message(greenhouseState("resume"));
    });

    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());
    expect(screen.getByRole("region", { name: "Greenhouse" })).toBeTruthy();

    act(() => {
      harness.close(1006);
      harness.open();
      harness.message(welcomeWithWallet("0", "2"));
      harness.message({ type: "PROGRESSION_SNAPSHOT", progression: {
        playerId: "player-1", totalXp: 0, level: 1, curveVersion: 1, persistenceVersion: 1,
        xpIntoLevel: 0, xpForNextLevel: 100, nextLevelTotalXp: 100, atCap: false,
        pveStats: { maxHealth: 100, attackPower: 10, defense: 0 }
      } } as ServerMessage);
      harness.message(greenhouseInteriorLocation());
      harness.message(greenhouseState("reconnect"));
    });

    await waitFor(() => expect(screen.getByRole("region", { name: "Greenhouse" })).toBeTruthy());
    view.unmount();
  });

  it("keeps respawn available after reconnect before world presentation converges", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    vi.spyOn(startupState, "isStartupPresentationReady").mockReturnValue(true);
    vi.spyOn(startupState, "isCurrentWorldPresentation").mockReturnValue(true);

    act(() => {
      harness.open();
      harness.message(welcomeWithWallet("0", "1"));
    });
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));

    act(() => {
      harness.message(dungeonCombatSnapshot({
        playerHealth: 0,
        respawnAvailableAt: 105_000,
        serverTime: 100_000,
        includeEnemy: false
      }));
    });

    expect(screen.queryByText("Reconnect to respawn.")).toBeNull();
    act(() => harness.close(1006));
    expect(screen.getByText("Reconnect to respawn.")).toBeTruthy();

    act(() => harness.open());
    expect(screen.getByText("Reconnect to respawn.")).toBeTruthy();
    act(() => harness.message(welcomeWithWallet("0", "1")));
    expect(screen.queryByText("Reconnect to respawn.")).toBeNull();

    const countdown = screen.getByRole("button", { name: "Respawn (5)" }) as HTMLButtonElement;
    expect(countdown.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(5_000); });
    const respawn = screen.getByRole("button", { name: "Respawn" }) as HTMLButtonElement;
    expect(respawn.disabled).toBe(false);
    fireEvent.click(respawn);
    fireEvent.click(respawn);
    expect(harness.respawnPlayer).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("clears a retained dungeon scene when canonical location returns to the world", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);

    await waitFor(() => expect(harness.counts()["game-client-connected"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());
    const entrance = cisternWarrensEntrance();
    act(() => {
      harness.message(dungeonSnapshotUpdate());
      harness.message({ type: "DUNGEON_ENTRANCES", entrances: [entrance] });
    });
    expect(harness.clearDungeonScene).not.toHaveBeenCalled();

    act(() => harness.message(canonicalWorldLocationSnapshot()));

    expect(harness.clearDungeonScene).toHaveBeenCalledOnce();
    act(() => harness.selectDungeonEntrance(entrance));
    const prompt = screen.getByRole("complementary", { name: "Cistern Warrens Entrance actions" });
    expect(within(prompt).getByRole("button", { name: "Read Warning" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Read Warning" }));
    expect(within(screen.getByRole("complementary", { name: "Cistern Warrens Entrance actions" }))
      .getByRole("button", { name: "Close" })).toBeTruthy();
    expect(harness.counts()).toMatchObject({
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });
    view.unmount();
  });

  it("forces a client update when the server rejects the protocol", async () => {
    const harness = createRuntimeHarness();
    const checkForRequiredUpdate = vi.fn(async () => true);
    const view = render(
      gameElement(harness.factories, playerOneSession, checkForRequiredUpdate)
    );
    await waitFor(() =>
      expect(harness.counts()["game-client-connected"]).toBe(1)
    );

    act(() => harness.protocolIncompatible());

    expect(checkForRequiredUpdate).toHaveBeenCalledOnce();
    expect(checkForRequiredUpdate).toHaveBeenCalledWith(true);
    view.unmount();
  });

  it("checks for a required client update immediately on a planned restart", async () => {
    const harness = createRuntimeHarness();
    const checkForRequiredUpdate = vi.fn(async () => false);
    const view = render(
      gameElement(harness.factories, playerOneSession, checkForRequiredUpdate)
    );
    await waitFor(() =>
      expect(harness.counts()["game-client-connected"]).toBe(1)
    );

    act(() => harness.close(1012));

    expect(checkForRequiredUpdate).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps committed deer leather when an older bootstrap inventory arrives", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() =>
      expect(harness.counts()["game-client-connected"]).toBe(1)
    );

    act(() => {
      harness.message(deerRewardGranted(inventoryWithLeather(1, 12)));
      harness.message(playerResourcesUpdated(inventoryWithLeather(0, 11)));
    });

    expect(harness.latestInventorySnapshot()).toMatchObject({
      revision: 12,
      totals: { leather: 1 }
    });
    view.unmount();
  });

  it("requires a fresh inventory snapshot after a same-player welcome", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() =>
      expect(harness.counts()["game-client-connected"]).toBe(1)
    );
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    act(() => {
      harness.message(playerResourcesUpdated(inventoryWithLeather(1, 12)));
    });
    fireEvent.keyDown(window, { key: "i" });
    expect(screen.getByRole("button", { name: /Leather, quantity 1/ })).not.toBeNull();

    act(() => {
      harness.message(welcomeWithWallet("0", "1"));
    });
    expect(screen.queryByRole("button", { name: /Leather, quantity 1/ })).toBeNull();
    expect(screen.getByText("Loading inventory…")).not.toBeNull();

    act(() => {
      harness.message(playerResourcesUpdated(inventoryWithLeather(2, 1)));
    });
    expect(harness.latestInventorySnapshot()).toMatchObject({
      revision: 1,
      totals: { leather: 2 }
    });
    expect(screen.getByRole("button", { name: /Leather, quantity 2/ })).not.toBeNull();
    view.unmount();
  });

  it("installs Gold from authenticated bootstrap without an economy mutation", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() =>
      expect(harness.counts()["game-client-connected"]).toBe(1)
    );
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    act(() => harness.message(welcomeWithWallet("321", "7")));

    expect(view.getByText("321")).toBeTruthy();
    view.unmount();
  });

  it("recreates each owned runtime exactly once for a genuine player replacement", async () => {
    const harness = createRuntimeHarness();
    const clearTimeline = vi.spyOn(PlayerRenderTimeline.prototype, "clear");
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    const clearCallsBeforeReplacement = clearTimeline.mock.calls.length;

    view.rerender(gameElement(harness.factories, {
      ...playerOneSession,
      account: { ...playerOneSession.account, id: "account-2" },
      player: { ...playerOneSession.player, id: "player-2", displayName: "Ranger" }
    }));

    await waitFor(() => expect(harness.counts()).toMatchObject({
      "map-runtime-created": 2,
      "map-runtime-destroyed": 1,
      "pixi-overlay-created": 2,
      "pixi-overlay-destroyed": 1,
      "game-client-created": 2,
      "game-client-connected": 2,
      "game-client-disconnected": 1
    }));
    expect(clearTimeline.mock.calls.length).toBeGreaterThan(clearCallsBeforeReplacement);

    view.unmount();
    expect(harness.counts()).toMatchObject({
      "map-runtime-destroyed": 2,
      "pixi-overlay-destroyed": 2,
      "game-client-disconnected": 2
    });
  });

  it("keeps map, Pixi, client, and WebSocket ownership stable across compact-wide transitions", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "pixi-overlay-created": 1,
      "game-client-created": 1,
      "game-client-connected": 1
    }));

    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(document.documentElement.dataset.layoutMode).toBe("compact");

    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(document.documentElement.dataset.layoutMode).toBe("wide");
    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 0,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });

    view.unmount();
  });

  it("keeps permanent runtime ownership stable across world-Manor-world transitions", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "pixi-overlay-created": 1,
      "game-client-created": 1,
      "game-client-connected": 1
    }));

    act(() => harness.message(manorEnteredMessage()));
    act(() => harness.message({
      type: "MANOR_EXITED",
      reason: "Left the manor.",
      player: manorExitPlayer()
    }));

    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 0,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });

    view.unmount();
    expect(harness.counts()).toMatchObject({
      "map-runtime-destroyed": 1,
      "pixi-overlay-destroyed": 1,
      "game-client-disconnected": 1
    });
  });

  it("reconciles the retained local player when the app returns to the foreground", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    expect(harness.reconcileLocalPlayer).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    const resumeCallStart = harness.overlayRenderCalls().length;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(harness.reconcileLocalPlayer).toHaveBeenCalledTimes(2));
    expect(harness.overlayRenderCalls().slice(resumeCallStart)).toEqual([
      "mark-map-transform-dirty",
      "paint-current-frame",
      "reconcile-local-player"
    ]);
    view.unmount();
  });

  it("freezes mob publication during reconnect without replacing the overlay", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    harness.commitMobPresentation();

    act(() => {
      harness.open();
      harness.close(1006);
      harness.open();
    });

    expect(harness.mobPresentationReadiness().slice(-4)).toEqual([
      true,
      false,
      false,
      false
    ]);
    expect(harness.counts()).toMatchObject({
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0
    });
    view.unmount();
  });

  it("projects an accepted Manor exit before validating movement against the new leash", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    const stalePlayer = manorExitPlayer({
      lat: 35,
      lon: -106,
      anchorLat: 35,
      anchorLon: -106,
      updatedAt: "2026-09-17T00:00:00.000Z"
    });
    const exitedPlayer = manorExitPlayer({
      lat: 35.101,
      lon: -106.602,
      anchorLat: 35.101,
      anchorLon: -106.602,
      updatedAt: "2026-09-17T00:01:00.000Z"
    });

    act(() => {
      harness.message(strategicWelcome());
      harness.message({
        type: "PLAYER_SNAPSHOT",
        serverTime: 1,
        sequence: 1,
        players: [stalePlayer]
      });
      harness.message({
        type: "MANOR_EXITED",
        reason: "Left the manor.",
        player: exitedPlayer
      });
    });

    expect(harness.canonicalPlayer()).toMatchObject({
      anchorLat: exitedPlayer.anchorLat,
      anchorLon: exitedPlayer.anchorLon
    });

    act(() => {
      harness.manualMove({ lat: exitedPlayer.lat, lon: exitedPlayer.lon });
    });

    expect(harness.moveTo).toHaveBeenCalledWith(
      exitedPlayer.lat,
      exitedPlayer.lon,
      undefined
    );
    view.unmount();
  });

  it("renders destination mobs on the first committed frame when FLAG_VISITED follows combat", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    act(() => {
      harness.message(destinationPlayerSnapshot());
      harness.message(destinationPopulationReady());
      harness.message(destinationCombatSnapshot());
      harness.message(destinationCollectiblesSnapshot());
      harness.message(destinationFlagVisited());
    });

    expect(harness.firstCommittedMobIds()).toBeNull();
    expect(harness.flagTravelInstrumentationEvents()).toContain(
      "destination-data-ready"
    );
    act(() => harness.finishFlagTravelCommit());

    expect(harness.firstCommittedMobIds()).toEqual(["destination-mob"]);
    expect(harness.flagTravelPresentationEvents()).toEqual([
      "capture",
      "commit"
    ]);
    expect(harness.markAuthoritativeViewDegraded).not.toHaveBeenCalled();
    view.unmount();
  });

  it("paints the snapped player before one smooth flag-anchor camera pan", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    act(() => harness.message(destinationPlayerSnapshot()));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    harness.resetCameraMoves();

    act(() => {
      harness.message(destinationFlagVisited());
      harness.message(destinationPopulationReady());
      harness.message(destinationCombatSnapshot());
      harness.message(destinationCollectiblesSnapshot());
    });

    expect(harness.cameraMoves()).toEqual(["ease"]);
    expect(harness.cameraPresentationOrder()).toEqual([
      "player-painted",
      "camera-ease"
    ]);
    expect(harness.flagTravelPresentationEvents()).not.toContain("player-motion");

    act(() => harness.finishFlagTravelCommit());

    expect(harness.cameraMoves()).toEqual(["ease"]);
    expect(
      harness.flagTravelPresentationEvents()
        .filter((event) => event === "commit")
    ).toHaveLength(1);
    view.unmount();
  });

  it("renders destination mobs on the first committed frame when FLAG_VISITED arrives first", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    act(() => {
      harness.message(destinationFlagVisited());
      harness.message(destinationPlayerSnapshot());
      harness.message(destinationPopulationReady());
      harness.message(destinationCombatSnapshot());
      harness.message(destinationCollectiblesSnapshot());
    });

    expect(harness.firstCommittedMobIds()).toBeNull();
    expect(harness.flagTravelInstrumentationEvents()).toContain(
      "destination-data-ready"
    );
    act(() => harness.finishFlagTravelCommit());

    expect(harness.firstCommittedMobIds()).toEqual(["destination-mob"]);
    expect(harness.flagTravelPresentationEvents()).toEqual([
      "capture",
      "mob-ready:true",
      "commit"
    ]);
    expect(harness.markAuthoritativeViewDegraded).not.toHaveBeenCalled();
    view.unmount();
  });

  it("accepts a newer destination resource epoch after FLAG_VISITED", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    act(() => {
      harness.message(destinationFlagVisited());
      harness.message(destinationPlayerSnapshot());
      harness.message(destinationPopulationReady(10));
      harness.message(destinationCombatSnapshot(10));
      harness.message(destinationCollectiblesSnapshot(10));
    });

    expect(harness.flagTravelInstrumentationEvents()).toContain(
      "destination-data-ready"
    );
    act(() => harness.finishFlagTravelCommit());

    expect(harness.flagTravelPresentationEvents()).toContain("commit");
    view.unmount();
  });

  it.each([
    ["flag travel", () => destinationFlagVisited()],
    ["city travel", () => destinationCityVisited()],
    ["world-map manor travel", () => destinationTravelResult()],
    ["salon exit", () => destinationSalonExited()]
  ])("refreshes all 3 km flags after partial %s authority becomes exact", async (
    _label,
    arrival
  ) => {
    let strategicRequestCount = 0;
    const strategicFetch = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).endsWith("/api/map/strategic-vision")) {
        return new Response("{}", { status: 200 });
      }
      strategicRequestCount += 1;
      const snapshot = strategicRequestCount === 1
        ? strategicVisionSnapshot(
            { lat: 35, lon: -106 },
            1,
            1,
            ["origin-strategic"]
          )
        : strategicVisionSnapshot(
            {
              lat: destinationPlayer().anchorLat,
              lon: destinationPlayer().anchorLon
            },
            DESTINATION_AUTHORITY.relocationRevision,
            DESTINATION_AUTHORITY.gameplayViewGeneration,
            [
              "destination-strategic-a",
              "destination-strategic-b",
              "destination-strategic-c"
            ]
          );
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", strategicFetch);
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    act(() => harness.message(strategicWelcome()));
    await waitFor(() =>
      expect(harness.renderedFlagIds()).toContain("origin-strategic")
    );

    act(() => {
      harness.message(arrival());
      harness.message(destinationPopulationReady());
    });

    await waitFor(() =>
      expect(harness.renderedFlagIds()).toEqual([
        "destination-strategic-a",
        "destination-strategic-b",
        "destination-strategic-c"
      ])
    );
    expect(harness.renderedFlagIds()).not.toContain("origin-strategic");
    expect(strategicRequestCount).toBe(2);
    view.unmount();
  });

  it("locks map dragging until the flag-travel destination is committed", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    act(() => harness.message(destinationFlagVisited()));
    expect(harness.dragPanEnabled()).toBe(false);

    act(() => {
      harness.message(destinationPlayerSnapshot());
      harness.message(destinationPopulationReady());
      harness.message(destinationCombatSnapshot());
      harness.message(destinationCollectiblesSnapshot());
      harness.finishFlagTravelCommit();
    });

    expect(harness.dragPanEnabled()).toBe(true);
    view.unmount();
  });

  it("opens the canonical World Map by holding the dock vitals without recreating runtimes", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    const locate = await screen.findByRole("button", {
      name: "Player resources. Tap to center the map on you; hold for the World Map"
    });
    vi.useFakeTimers();
    fireEvent.pointerDown(locate, { button: 0, isPrimary: true, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(500); });

    expect(screen.getByRole("dialog", { name: "World Map" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Game Menu" })).toBeNull();
    expect(harness.cameraEaseOptions()).toEqual([]);
    const mapRoot = document.querySelector<HTMLElement>(".map-root");
    expect(mapRoot).not.toBeNull();
    expect(mapRoot!.classList.contains("world-map-suspended")).toBe(true);
    expect(mapRoot!.inert).toBe(true);
    expect(harness.dragPanEnabled()).toBe(false);
    expect(harness.renderingActivity().at(-1)).toBe(false);
    const pixiResizeCountWhileOpen = harness.pixiResizeCount();
    expect(pixiResizeCountWhileOpen).toBeGreaterThan(0);
    const resizeCountWhileOpen = harness.mapResizeCount();
    expect(resizeCountWhileOpen).toBeGreaterThan(0);

    fireEvent.pointerUp(locate, { pointerId: 1 });
    fireEvent.click(locate);
    expect(harness.cameraEaseOptions()).toEqual([]);
    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 0,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });

    fireEvent.click(screen.getByRole("button", { name: "Close World Map" }));
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: {
        ashAtlasMobileMenuView: "menu",
        ashAtlasMobileMenuDepth: 1
      } }));
    });
    expect(screen.queryByRole("dialog", { name: "World Map" })).toBeNull();
    expect(mapRoot!.classList.contains("world-map-suspended")).toBe(false);
    expect(mapRoot!.inert).toBe(false);
    expect(harness.dragPanEnabled()).toBe(true);
    expect(harness.renderingActivity().at(-1)).toBe(true);
    expect(harness.pixiResizeCount()).toBeGreaterThan(pixiResizeCountWhileOpen);
    expect(harness.mapResizeCount()).toBeGreaterThan(resizeCountWhileOpen);
    expect(harness.overlayRenderCalls().slice(-3)).toEqual([
      "mark-map-transform-dirty",
      "paint-current-frame",
      "reconcile-local-player"
    ]);
    expect(harness.counts()).toMatchObject({
      "map-runtime-created": 1,
      "map-runtime-destroyed": 0,
      "pixi-overlay-created": 1,
      "pixi-overlay-destroyed": 0,
      "game-client-created": 1,
      "game-client-connected": 1,
      "game-client-disconnected": 0
    });
    view.unmount();
  });

  it("covers the gameplay map in the first render of a direct World Map handoff", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /^Open Game Menu/ }));
    const menu = screen.getByRole("dialog", { name: "Game Menu" });
    worldMapRenderStates.length = 0;
    fireEvent.click(within(menu).getByRole("button", { name: "Atlas" }));

    expect(worldMapRenderStates[0]).toBe(true);
    expect(screen.getByRole("dialog", { name: "World Map" })).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".map-root")?.classList.contains("world-map-suspended"))
      .toBe(true);
    view.unmount();
  });

  it("requests military data when Construction opens directly and resolves its loading cards", async () => {
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /^Open Game Menu/ }));
    const menu = screen.getByRole("dialog", { name: "Game Menu" });
    fireEvent.click(within(menu).getByRole("button", { name: "Construction" }));
    fireEvent.click(screen.getByRole("tab", { name: "City" }));

    expect(harness.requestMilitaryIndustry).toHaveBeenCalledTimes(2);
    const lodgeCard = screen.getByRole("heading", { name: "Lodge" }).closest<HTMLElement>(".game-app-card");
    expect(lodgeCard).not.toBeNull();
    expect(within(lodgeCard!).getByRole("img", { name: "Cannot build yet" })).toBeTruthy();
    expect(within(lodgeCard!).getAllByText("Loading military records…")).toHaveLength(1);
    for (const title of ["Barracks", "Demolition Factory"]) {
      const card = screen.getByRole("heading", { name: title }).closest<HTMLElement>(".game-app-card");
      expect(card).not.toBeNull();
      expect(within(card!).getByRole("img", { name: "Cannot build yet" })).toBeTruthy();
      expect(within(card!).getAllByText("Loading military records…")).toHaveLength(1);
    }

    act(() => harness.message(militaryIndustryState()));

    // Card status is an inline mark now (no status text), so the loaded state is the absent loading copy.
    await waitFor(() => {
      expect(within(lodgeCard!).queryByText("Loading military records…")).toBeNull();
    });
    expect(within(lodgeCard!).queryByText("Loading military records…")).toBeNull();
    expect(within(lodgeCard!).getByRole("button", { name: "Build Lodge" })).toBeTruthy();
    for (const title of ["Barracks", "Demolition Factory"]) {
      const card = screen.getByRole("heading", { name: title }).closest<HTMLElement>(".game-app-card");
      expect(card).not.toBeNull();
      expect(within(card!).queryByText("Loading military records…")).toBeNull();
      expect(within(card!).getByRole("button", { name: `Build ${title}` })).toBeTruthy();
    }
    view.unmount();
  });

  it.each(["anchor", "select"])("keeps Planner Anchor actions open and repeatable in %s mode", async (mode) => {
    const storageKey = "ash-atlas.planning-anchors.v1:player-1:world";
    window.localStorage.setItem(storageKey, JSON.stringify(addPlanningAnchor(EMPTY_PLANNING_ANCHORS, {
      id: "anchor-1", position: { lat: 0, lon: 0 }, distanceM: 575,
      source: { kind: "flag", id: "flag-1", label: "Flag", position: { lat: 0, lon: 0 } }
    })));
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => { harness.open(); harness.message(planningSiegeState()); });
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());
    // Holding the flag/buoy builder quick slot opens planning.
    const buildSlot = await screen.findByRole("button", { name: /hold for planning mode/ });
    fireEvent.pointerDown(buildSlot, { button: 0, pointerId: 1, pointerType: "touch" });
    await screen.findByRole("button", { name: "Switch to Select mode" });
    fireEvent.pointerUp(buildSlot, { button: 0, pointerId: 1, pointerType: "touch" });
    if (mode === "select") fireEvent.click(screen.getByRole("button", { name: "Switch to Select mode" }));

    // No prior group selection is required; the padded marker hit owns the opening event.
    act(() => harness.clickPlanningPoint(19, 0));
    expect(harness.planningPointIsImmediate(19, 0)).toBe(true);
    expect(harness.planningPointIsImmediate(21, 0)).toBe(false);
    const actionName = "Move Kippen Siege +1 to Anchor 1";
    expect((screen.getByRole("button", { name: actionName }) as HTMLButtonElement).disabled).toBe(false);
    // Snapshot updates and selection clearing must not tear down the Anchor intent.
    act(() => harness.message(planningSiegeState()));
    expect(screen.getByRole("heading", { name: "Anchor 1" })).toBeTruthy();
    expect(harness.moveMilitaryGroup).not.toHaveBeenCalled();
    expect(harness.moveTo).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByLabelText("Anchor 1 actions")).getByRole("button", { name: "Cancel" }));
    act(() => harness.clickPlanningPoint(0, 0));
    const outside = screen.getByLabelText("Anchor 1 actions").parentElement!;
    fireEvent.pointerDown(outside, { pointerId: 2 });
    expect(screen.getByRole("heading", { name: "Anchor 1" })).toBeTruthy();
    fireEvent.pointerUp(outside, { pointerId: 2 });
    fireEvent.click(outside);
    expect(screen.queryByRole("heading", { name: "Anchor 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: mode === "anchor" ? "Switch to Select mode" : "Switch to Anchor mode" }));
    act(() => harness.clickPlanningPoint(0, 0));
    fireEvent.click(screen.getByRole("button", { name: actionName }));
    expect(harness.moveMilitaryGroup).toHaveBeenCalledWith("siege-1", { lat: 0, lon: 0 });
    expect(screen.queryByRole("heading", { name: "Anchor 1" })).toBeNull();

    act(() => { harness.message(planningSiegeState("PACKING_UP")); harness.clickPlanningPoint(0, 0); });
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
    expect(screen.queryByText("This military group is packing up and cannot move.")).toBeNull();
    expect(harness.moveMilitaryGroup).toHaveBeenCalledTimes(1);
    act(() => harness.message(planningSiegeState("DEPLOYED_FIELD", "other-player")));
    expect(screen.queryByRole("button", { name: actionName })).toBeNull();
    expect(screen.getByText("No Siege groups available.")).toBeTruthy();
    view.unmount();
    window.localStorage.removeItem(storageKey);
  });

  it("owns Planner Pencil taps without claiming ordinary movement after mode exit", async () => {
    const storageKey = "ash-atlas.planning-anchors.v1:player-1:world";
    window.localStorage.setItem(storageKey, JSON.stringify(EMPTY_PLANNING_ANCHORS));
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => { harness.open(); harness.message(planningSiegeState()); });
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());

    // Holding the flag/buoy builder quick slot opens planning.
    const buildSlot = await screen.findByRole("button", { name: /hold for planning mode/ });
    fireEvent.pointerDown(buildSlot, { button: 0, pointerId: 1, pointerType: "touch" });
    await screen.findByRole("button", { name: "Switch to Select mode" });
    fireEvent.pointerUp(buildSlot, { button: 0, pointerId: 1, pointerType: "touch" });
    fireEvent.click(screen.getByRole("button", { name: "Pencil mode" }));

    expect(harness.planningPointIsImmediate(19, 0)).toBe(true);
    act(() => harness.clickPlanningPoint(0, 0));
    act(() => harness.clickPlanningPoint(1, 1));
    harness.manualMove({ lat: 1, lon: 1 });
    expect(harness.moveTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Anchor mode" }));
    expect(harness.planningPointIsImmediate(19, 0)).toBe(false);

    view.unmount();
    window.localStorage.removeItem(storageKey);
  });

  it("restores the saved phone zoom and recenters on a quick Locate click", async () => {
    window.localStorage.setItem(
      "ashAtlas.player.player-1.mobileDefaultZoom.v1",
      "14.75"
    );
    const harness = createRuntimeHarness();
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    mockGameplayReady();
    act(() => harness.open());
    await waitFor(() => expect(screen.queryByText(/Preparing the world/)).toBeNull());
    act(() => harness.message(destinationPlayerSnapshot()));

    fireEvent.click(await screen.findByRole("button", {
      name: "Player resources. Tap to center the map on you; hold for the World Map"
    }));

    await waitFor(() => expect(harness.cameraEaseOptions()).toHaveLength(1));
    expect(harness.cameraEaseOptions()[0]).toMatchObject({
      center: [-106.602, 35.101],
      duration: 600,
      zoom: 14.75
    });
    expect(screen.queryByRole("dialog", { name: "World Map" })).toBeNull();

    view.unmount();
    window.localStorage.removeItem(
      "ashAtlas.player.player-1.mobileDefaultZoom.v1"
    );
  });

  it("restarts Pixi when flag travel interrupts a manual viewport interaction", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));

    act(() => harness.beginMapDrag());
    expect(harness.viewportInteractionActivity().at(-1)).toBe(true);

    act(() => harness.message(destinationFlagVisited()));

    expect(harness.viewportInteractionActivity().at(-1)).toBe(false);
    view.unmount();
  });

  it("replaces an unfinished retained presentation when another flag arrival wins", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    vi.useFakeTimers();

    act(() => {
      harness.message(destinationFlagVisited());
      harness.message(nextDestinationFlagVisited());
      harness.finishFlagTravelCommit();
      vi.advanceTimersByTime(650);
    });

    expect(
      harness.flagTravelPresentationEvents()
        .filter((event) => event === "commit")
    ).toHaveLength(2);
    expect(harness.dragPanEnabled()).toBe(true);
    view.unmount();
  });

  it("releases a stalled flag-travel presentation when destination data never converges", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    vi.useFakeTimers();

    act(() => {
      harness.message(destinationFlagVisited());
      harness.finishFlagTravelCommit();
    });
    expect(harness.flagTravelPresentationEvents()).not.toContain("player-motion");
    expect(harness.flagTravelPresentationEvents()).not.toContain("commit");
    expect(harness.dragPanEnabled()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(harness.flagTravelPresentationEvents()).toContain("commit");
    expect(harness.dragPanEnabled()).toBe(true);
    view.unmount();
  });

  it("completes party-follow travel without depending on camera animation frames", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query.includes("max-width") ||
        query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));

    act(() => harness.message({
      ...destinationFlagVisited(),
      requestId: "party-follow:event-1:player-1"
    } as ServerMessage));
    expect(harness.cameraMoves()).toContain("jump");
    expect(harness.flagTravelPresentationEvents()).not.toContain("player-motion");
    expect(harness.flagTravelPresentationEvents()).not.toContain("commit");
    expect(harness.dragPanEnabled()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(harness.flagTravelPresentationEvents()).toContain("commit");
    expect(harness.flagTravelInstrumentationEvents()).not.toContain(
      "presentation-deadline-released"
    );
    expect(harness.dragPanEnabled()).toBe(true);
    view.unmount();
  });

  it("never covers stalled flag travel and still releases its presentation", async () => {
    const harness = createRuntimeHarness({ deferFlagTravelCommit: true });
    const view = renderGame(harness.factories, playerOneSession);
    await waitFor(() => expect(harness.counts()["pixi-overlay-created"]).toBe(1));
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query.includes("max-width") ||
        query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));
    vi.useFakeTimers();

    act(() => harness.message(destinationFlagVisited()));
    expect(view.container.querySelector(".flag-travel-cover")).toBeNull();
    expect(harness.dragPanEnabled()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(harness.flagTravelPresentationEvents()).toContain("commit");
    expect(view.container.querySelector(".flag-travel-cover")).toBeNull();
    expect(harness.dragPanEnabled()).toBe(true);
    view.unmount();
  });
});

function renderGame(
  factories: GameRuntimeFactories,
  session: typeof playerOneSession
) {
  return render(gameElement(factories, session));
}

function gameElement(
  factories: GameRuntimeFactories,
  session: typeof playerOneSession,
  checkForRequiredUpdate = vi.fn(async () => false)
): React.JSX.Element {
  return (
    <UiEnvironmentProvider>
      <GameApp
        session={session}
        onLogout={vi.fn(async () => undefined)}
        onSessionEnded={vi.fn()}
        verifySession={vi.fn(async () => true)}
        checkForRequiredUpdate={checkForRequiredUpdate}
        onServerComponentRelease={vi.fn()}
        runtimeFactories={factories}
      />
    </UiEnvironmentProvider>
  );
}

function createRuntimeHarness(options: Readonly<{
  deferFlagTravelCommit?: boolean;
}> = {}): {
  factories: GameRuntimeFactories;
  clearDungeonScene: ReturnType<typeof vi.fn>;
  startAttack: ReturnType<typeof vi.fn>;
  respawnPlayer: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  moveMilitaryGroup: ReturnType<typeof vi.fn>;
  clickPlanningPoint(x: number, y: number): void;
  planningPointIsImmediate(x: number, y: number): boolean;
  reconcileLocalPlayer: ReturnType<typeof vi.fn>;
  overlayRenderCalls(): string[];
  markAuthoritativeViewDegraded: ReturnType<typeof vi.fn>;
  canonicalPlayer(): { anchorLat: number; anchorLon: number } | null;
  open(): void;
  close(code: number): void;
  protocolIncompatible(): void;
  commitMobPresentation(): void;
  mobPresentationReadiness(): boolean[];
  counts(): Record<GameRuntimeLifecycleEvent, number>;
  message(message: ServerMessage): void;
  beginMapDrag(): void;
  viewportInteractionActivity(): boolean[];
  renderingActivity(): boolean[];
  pixiResizeCount(): number;
  mapResizeCount(): number;
  finishFlagTravelCommit(): void;
  firstCommittedMobIds(): string[] | null;
  flagTravelPresentationEvents(): string[];
  flagTravelInstrumentationEvents(): string[];
  cameraMoves(): string[];
  cameraEaseOptions(): Array<{
    center?: [number, number];
    duration?: number;
    zoom?: number;
  }>;
  cameraPresentationOrder(): string[];
  resetCameraMoves(): void;
  dragPanEnabled(): boolean;
  manualMove(target?: { lat: number; lon: number }): void;
  selectDrop(drop: DroppedItemSnapshot): void;
  selectDungeonEntrance(entrance: DungeonEntranceSnapshot): void;
  selectDungeonEnemy(entityId: string): void;
  latestInventorySnapshot(): PlayerInventorySnapshot | null;
  latestPickupRecommendation(): number | null;
  renderedFlagIds(): string[];
  requestMilitaryIndustry: ReturnType<typeof vi.fn>;
} {
  const events = new Map<GameRuntimeLifecycleEvent, number>();
  const flagTravelInstrumentationEvents: string[] = [];
  let handlers: GameClientHandlers | null = null;
  let mapHandlers: MapRuntimeHandlers | null = null;
  let selectedDrop: DroppedItemSnapshot | null = null;
  let selectedDungeonEntrance: DungeonEntranceSnapshot | null = null;
  let selectedDungeonEnemyId: string | null = null;
  let pickupRecommendation: number | null = null;
  let inventorySnapshot: PlayerInventorySnapshot | null = null;
  let combatStore: CombatStore | null = null;
  let moveEndHandler: (() => void) | null = null;
  let dragPanEnabled = true;
  let flagTravelPresentationActive = false;
  let renderedFlagIds: string[] = [];
  let mobPresentationReady = false;
  let canonicalPlayer: { anchorLat: number; anchorLon: number } | null = null;
  const mobPresentationReadiness: boolean[] = [];
  const viewportInteractionActivity: boolean[] = [];
  const renderingActivity: boolean[] = [];
  let pixiResizeCount = 0;
  let mapResizeCount = 0;
  let nextCaptureId = 1;
  const committedMobIds: string[][] = [];
  const flagTravelPresentationEvents: string[] = [];
  const cameraMoves: string[] = [];
  const cameraEaseOptions: Array<{
    center?: [number, number];
    duration?: number;
    zoom?: number;
  }> = [];
  const cameraPresentationOrder: string[] = [];
  const overlayRenderCalls: string[] = [];
  const reconcileLocalPlayer = vi.fn(() => {
    overlayRenderCalls.push("reconcile-local-player");
    if (flagTravelPresentationActive) {
      cameraPresentationOrder.push("player-painted");
    }
    return true;
  });
  const markAuthoritativeViewDegraded = vi.fn();
  const clearDungeonScene = vi.fn();
  const startAttack = vi.fn(() => ({ outcome: { status: "sent" } }));
  const respawnPlayer = vi.fn(() => ({
    requestId: "respawn-request-1",
    outcome: { status: "sent" }
  }));
  const moveTo = vi.fn(() => "movement-request-1");
  const moveMilitaryGroup = vi.fn(() => "military-move-1");
  const requestMilitaryIndustry = vi.fn(() => "military-request-1");
  window.__ASH_ATLAS_RUNTIME_LIFECYCLE_OBSERVER__ = (event) => {
    events.set(event, (events.get(event) ?? 0) + 1);
  };
  window.__ASH_ATLAS_FLAG_TRAVEL_PRESENTATION_OBSERVER__ = (event) => {
    flagTravelInstrumentationEvents.push(event);
  };

  const canvasContainer = document.createElement("div");
  const mapCanvas = document.createElement("canvas");
  Object.defineProperties(mapCanvas, {
    clientWidth: { value: 1_000 },
    clientHeight: { value: 600 }
  });
  const map = new Proxy({
    getContainer: () => canvasContainer,
    getCanvasContainer: () => canvasContainer,
    getCanvas: () => mapCanvas,
    getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    isSourceLoaded: () => true,
    loaded: () => false,
    once: vi.fn((event: string, handler: () => void) => {
      if (event === "moveend") moveEndHandler = handler;
    }),
    project: (position: unknown) =>
      options.deferFlagTravelCommit && Array.isArray(position)
        ? { x: 100, y: 100 }
        : { x: 0, y: 0 },
    getCenter: () => ({ lat: 0, lng: 0 }),
    getZoom: () => 14,
    dragPan: {
      isEnabled: () => dragPanEnabled,
      disable: vi.fn(() => { dragPanEnabled = false; }),
      enable: vi.fn(() => { dragPanEnabled = true; })
    },
    scrollZoom: { disable: vi.fn(), enable: vi.fn() },
    boxZoom: { disable: vi.fn(), enable: vi.fn() },
    keyboard: { disable: vi.fn(), enable: vi.fn() },
    touchZoomRotate: {
      disable: vi.fn(),
      enable: vi.fn(),
      disableRotation: vi.fn()
    },
    resize: vi.fn(() => { mapResizeCount += 1; }),
    triggerRepaint: vi.fn(),
    jumpTo: vi.fn(() => {
      cameraMoves.push("jump");
      cameraPresentationOrder.push("camera-jump");
    }),
    easeTo: vi.fn((options: {
      center?: [number, number];
      duration?: number;
      zoom?: number;
    }) => {
      cameraMoves.push("ease");
      cameraEaseOptions.push(options);
      cameraPresentationOrder.push("camera-ease");
    })
  }, {
    get(target, property) {
      if (property === "then") return undefined;
      if (property in target) return target[property as keyof typeof target];
      return vi.fn();
    }
  });
  const overlay = new Proxy({
    reconcileLocalPlayer,
    settleCurrentFrame: async () => true,
    markFollowTransformDirty: () => {
      overlayRenderCalls.push("mark-map-transform-dirty");
    },
    markMapTransformDirty: () => {
      overlayRenderCalls.push("mark-map-transform-dirty");
    },
    paintCurrentFrame: () => {
      overlayRenderCalls.push("paint-current-frame");
      return true;
    },
    update: (state: {
      flags: Array<{ id: string }>;
      players?: Array<{
        playerId: string;
        anchorLat: number;
        anchorLon: number;
      }>;
    }) => {
      renderedFlagIds = state.flags.map((flag) => flag.id).sort();
      canonicalPlayer = state.players?.find((player) => player.playerId === "player-1") ?? null;
    },
    setMobPresentationReady: (ready: boolean) => {
      mobPresentationReady = ready;
      mobPresentationReadiness.push(ready);
      if (flagTravelPresentationEvents.includes("capture")) {
        flagTravelPresentationEvents.push(`mob-ready:${ready}`);
      }
    },
    setViewportInteractionActive: (active: boolean) => {
      viewportInteractionActivity.push(active);
    },
    setRenderingActive: (active: boolean) => {
      renderingActivity.push(active);
    },
    resizeViewport: () => { pixiResizeCount += 1; },
    beginFlagTravelPresentation: () => {
      flagTravelPresentationEvents.push("capture");
      const newlyFrozen = !flagTravelPresentationActive;
      flagTravelPresentationActive = true;
      return { id: nextCaptureId++, newlyFrozen };
    },
    startFlagTravelPlayerMotion: () => {
      flagTravelPresentationEvents.push("player-motion");
      return true;
    },
    commitFlagTravelDestination: () => {
      flagTravelPresentationEvents.push("commit");
      flagTravelPresentationActive = false;
      committedMobIds.push(
        mobPresentationReady && combatStore
          ? combatStore.entities()
            .filter((entity) => entity.kind === "mob")
            .map((entity) => entity.entityId)
            .sort()
          : []
      );
      return true;
    },
    pickDroppedItemAt: () => selectedDrop,
    pickCollectibleAt: () => null,
    pickPlayerAt: () => null,
    pickCombatEntityAt: () => null,
    pickCityAt: () => null,
    pickManorAt: () => null,
    pickDungeonEntranceAt: () => selectedDungeonEntrance,
    whenInteriorReady: () => Promise.resolve(true),
    pickFlagAt: () => null,
    pickWorldObjectsAt: () => selectedDungeonEnemyId
      ? [{ kind: "combat_entity", value: { entityId: selectedDungeonEnemyId } }]
      : selectedDrop
      ? [{ kind: "dropped_item", value: selectedDrop }]
      : selectedDungeonEntrance
        ? [{ kind: "dungeon_entrance", value: selectedDungeonEntrance }]
      : []
  }, {
    get(target, property) {
      if (property === "then") return undefined;
      if (property in target) return target[property as keyof typeof target];
      return vi.fn();
    }
  }) as unknown as PixiGameOverlay;
  const domain = new Proxy({}, { get: () => vi.fn(() => null) });

  const factories: GameRuntimeFactories = {
    createMapRuntime: () => ({
      map,
      attach: (nextHandlers: MapRuntimeHandlers) => { mapHandlers = nextHandlers; },
      cancelPendingInteraction: vi.fn(),
      invalidateBaseMapPaint: vi.fn(),
      destroy: (beforeMapRemove?: () => void) => beforeMapRemove?.()
    } as unknown as GameMapRuntime),
    createOverlay: async (_map, _container, store) => {
      combatStore = store ?? null;
      return overlay;
    },
    observeInventorySnapshot: (snapshot) => {
      inventorySnapshot = snapshot;
    },
    observePickupRecommendation: (quantity) => {
      pickupRecommendation = quantity;
    },
    createClient: (_wsBase, nextHandlers) => {
      handlers = nextHandlers;
      return new Proxy({
        connect: vi.fn(),
        disconnect: vi.fn(),
        markAuthoritativeViewDegraded,
        clearDungeonScene,
        startAttack,
        respawnPlayer,
        moveTo,
        moveMilitaryGroup,
        requestMilitaryIndustry,
        materializeDungeonSnapshot: (snapshot: DungeonSnapshot | DungeonSnapshotUpdate) =>
          snapshot.snapshotKind === "full" ? snapshot : null,
        combatEquipment: domain,
        developer: domain,
        flags: domain,
        harvesting: domain,
        manor: domain,
        market: domain,
        party: domain,
        pets: domain,
        packages: domain,
        settlements: domain,
        social: domain,
        travel: domain,
        world: domain
      }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return vi.fn(() => null);
        }
      }) as unknown as GameClient;
    }
  };

  return {
    factories,
    clearDungeonScene,
    startAttack,
    respawnPlayer,
    moveTo,
    moveMilitaryGroup,
    clickPlanningPoint: (x, y) => mapHandlers?.onClick({ point: { x, y }, lngLat: { lat: 0, lng: 0 } } as never),
    planningPointIsImmediate: (x, y) => mapHandlers?.handleClickImmediately?.({ point: { x, y } } as never) ?? false,
    reconcileLocalPlayer,
    overlayRenderCalls: () => [...overlayRenderCalls],
    markAuthoritativeViewDegraded,
    canonicalPlayer: () => canonicalPlayer,
    open: () => {
      if (!handlers) throw new Error("Game client was not created.");
      handlers.onOpen();
    },
    close: (code) => {
      if (!handlers) throw new Error("Game client was not created.");
      handlers.onClose({ code } as CloseEvent);
    },
    protocolIncompatible: () => {
      if (!handlers) throw new Error("Game client was not created.");
      handlers.onProtocolIncompatible?.(
        "This Ash Atlas client is not compatible with the game server. Refresh to update."
      );
    },
    commitMobPresentation: () => overlay.setMobPresentationReady(true),
    mobPresentationReadiness: () => [...mobPresentationReadiness],
    counts: () => Object.fromEntries(
      [
        "map-runtime-created",
        "map-runtime-destroyed",
        "pixi-overlay-created",
        "pixi-overlay-destroyed",
        "game-client-created",
        "game-client-connected",
        "game-client-disconnected"
      ].map((event) => [event, events.get(event as GameRuntimeLifecycleEvent) ?? 0])
    ) as Record<GameRuntimeLifecycleEvent, number>,
    message: (message) => {
      if (!handlers) throw new Error("Game client was not created.");
      handlers.onMessage(message);
    },
    beginMapDrag: () => {
      if (!mapHandlers) throw new Error("Map runtime was not attached.");
      mapHandlers.onDragStart();
    },
    viewportInteractionActivity: () => [...viewportInteractionActivity],
    renderingActivity: () => [...renderingActivity],
    pixiResizeCount: () => pixiResizeCount,
    mapResizeCount: () => mapResizeCount,
    finishFlagTravelCommit: () => {
      const handler = moveEndHandler;
      if (handler) {
        moveEndHandler = null;
        handler();
      }
      mapHandlers?.onRender();
    },
    firstCommittedMobIds: () => committedMobIds[0] ?? null,
    flagTravelPresentationEvents: () => [...flagTravelPresentationEvents],
    flagTravelInstrumentationEvents: () => [
      ...flagTravelInstrumentationEvents
    ],
    cameraMoves: () => [...cameraMoves],
    cameraEaseOptions: () => [...cameraEaseOptions],
    cameraPresentationOrder: () => [...cameraPresentationOrder],
    resetCameraMoves: () => {
      cameraMoves.length = 0;
      cameraPresentationOrder.length = 0;
    },
    dragPanEnabled: () => dragPanEnabled,
    manualMove: (target = { lat: 1, lon: 1 }) => mapHandlers?.onMove({
      requested: target, target, outside: false
    }),
    selectDrop: (drop) => {
      selectedDrop = drop;
      if (!mapHandlers) throw new Error("Map runtime was not attached.");
      mapHandlers.onClick({
        point: { x: 10, y: 10 },
        lngLat: { lat: drop.lat, lng: drop.lon }
      } as never);
    },
    selectDungeonEnemy: (entityId) => {
      selectedDungeonEnemyId = entityId;
      if (!mapHandlers) throw new Error("Map runtime was not attached.");
      mapHandlers.onClick({
        point: { x: 10, y: 10 },
        lngLat: { lat: 0, lng: 0 }
      } as never);
    },
    selectDungeonEntrance: (entrance) => {
      selectedDungeonEntrance = entrance;
      if (!mapHandlers) throw new Error("Map runtime was not attached.");
      mapHandlers.onClick({
        point: { x: 10, y: 10 },
        lngLat: { lat: entrance.lat, lng: entrance.lon }
      } as never);
    },
    latestInventorySnapshot: () => inventorySnapshot,
    latestPickupRecommendation: () => pickupRecommendation,
    renderedFlagIds: () => [...renderedFlagIds],
    requestMilitaryIndustry
  };
}

const DESTINATION_AUTHORITY = {
  playerId: "player-1",
  connectionId: "connection-2",
  connectionGeneration: 2,
  relocationRevision: 7,
  resourceVisionRevision: 9,
  gameplayViewGeneration: 11,
  populationPreparationGeneration: 13
} as const;

function destinationPlayerSnapshot(): ServerMessage {
  return {
    type: "PLAYER_SNAPSHOT",
    serverTime: 1,
    sequence: 1,
    players: [destinationPlayer()]
  };
}

function destinationPopulationReady(
  resourceVisionRevision: number = DESTINATION_AUTHORITY.resourceVisionRevision
): ServerMessage {
  return {
    type: "POPULATION_ZONE_DELTA",
    playerId: DESTINATION_AUTHORITY.playerId,
    connectionId: DESTINATION_AUTHORITY.connectionId,
    connectionGeneration: DESTINATION_AUTHORITY.connectionGeneration,
    preparationGeneration:
      DESTINATION_AUTHORITY.populationPreparationGeneration,
    preparationTrigger: "flag-travel",
    preparationScope: "required-visible",
    requiredForGameplay: true,
    relocationRevision: DESTINATION_AUTHORITY.relocationRevision,
    resourceVisionRevision,
    gameplayViewGeneration:
      DESTINATION_AUTHORITY.gameplayViewGeneration,
    retainedZoneIds: [],
    activatedZoneIds: ["world:NM:destination"],
    releasedZoneIds: [],
    withheldZoneIds: [],
    upserts: [],
    removedEntityIds: [],
    visibleZoneCount: 1,
    readyVisibleZoneCount: 1,
    backgroundZoneCount: 0,
    readyBackgroundZoneCount: 0,
    zoneSnapshots: [],
    preparationReason: "ready",
    preparationResult: "ready",
    partial: false,
    terminal: true
  };
}

function destinationCombatSnapshot(
  resourceVisionRevision: number = DESTINATION_AUTHORITY.resourceVisionRevision
): ServerMessage {
  return {
    type: "COMBAT_SNAPSHOT",
    worldViewAuthority: {
      ...DESTINATION_AUTHORITY,
      resourceVisionRevision
    },
    combatSnapshotGeneration: 17,
    state: {
      serverTick: 1,
      serverTime: 1,
      sequence: 1,
      upserts: [{
        entityId: "destination-mob",
        kind: "mob",
        archetypeKey: "goblin",
        name: "Destination Goblin",
        level: 1,
        regionCode: "NM",
        zoneId: "world:NM:destination",
        lat: 35.101,
        lon: -106.602,
        maxHealth: 100,
        currentHealth: 100,
        lifeState: "alive",
        activityState: "idle",
        targetEntityId: null,
        revision: 1
      }],
      removedEntityIds: [],
      events: []
    }
  };
}

function dungeonCombatSnapshot(options: Readonly<{
  playerHealth?: number;
  respawnAvailableAt?: number | null;
  serverTime?: number;
  enemyHealth?: number;
  enemyLifeState?: "alive" | "defeated";
  includeEnemy?: boolean;
}> = {}): ServerMessage {
  const playerPosition = dungeonLocalToCombatPosition(100, 100);
  const enemyPosition = dungeonLocalToCombatPosition(200, 200);
  const enemyHealth = options.enemyHealth ?? 10;
  const enemyLifeState = options.enemyLifeState ?? (enemyHealth > 0 ? "alive" : "defeated");
  const regionCode = "interior:sewer:1";
  const zoneId = "interior:sewer:1:hatch_landing";
  const player = {
    entityId: "player-1",
    kind: "player" as const,
    archetypeKey: null,
    name: "Player",
    level: 1,
    regionCode,
    zoneId,
    lat: playerPosition.lat,
    lon: playerPosition.lon,
    maxHealth: 100,
    currentHealth: options.playerHealth ?? 100,
    lifeState: (options.playerHealth ?? 100) > 0 ? "alive" as const : "respawning" as const,
    activityState: "idle" as const,
    targetEntityId: null,
    revision: (options.playerHealth ?? 100) > 0 ? 1 : 2,
    ...(options.respawnAvailableAt !== undefined
      ? { respawnAvailableAt: options.respawnAvailableAt }
      : {})
  };
  const enemy = {
    entityId: "sewer-goblin",
    kind: "mob" as const,
    archetypeKey: "goblin" as const,
    name: "Sewer Goblin",
    level: 1,
    regionCode,
    zoneId,
    lat: enemyPosition.lat,
    lon: enemyPosition.lon,
    maxHealth: 10,
    currentHealth: enemyHealth,
    lifeState: enemyLifeState,
    activityState: "idle" as const,
    targetEntityId: null,
    revision: enemyLifeState === "alive" && enemyHealth > 0 ? 1 : 2
  };
  return {
    type: "COMBAT_SNAPSHOT",
    combatSnapshotGeneration: 1,
    state: {
      serverTick: 1,
      serverTime: options.serverTime ?? 1,
      sequence: 1,
      upserts: options.includeEnemy === false ? [player] : [player, enemy],
      removedEntityIds: [],
      events: []
    }
  };
}

function destinationCollectiblesSnapshot(
  resourceVisionRevision: number = DESTINATION_AUTHORITY.resourceVisionRevision
): ServerMessage {
  return {
    type: "COLLECTIBLES_SNAPSHOT",
    worldViewAuthority: {
      ...DESTINATION_AUTHORITY,
      resourceVisionRevision
    },
    authority: {
      snapshotId: "destination-resources",
      snapshotGeneration: 23,
      gameplayViewGeneration: DESTINATION_AUTHORITY.gameplayViewGeneration,
      scope: { kind: "flag", id: "destination-flag" },
      includedDomains: ["resource-vision", "repeatable-resource"],
      completeness: "complete",
      ordinaryNodesTruncated: false,
      returnedCount: 0,
      authoritativeTotalCount: 0
    },
    playerId: DESTINATION_AUTHORITY.playerId,
    relocationRevision: DESTINATION_AUTHORITY.relocationRevision,
    resourceVisionRevision,
    serverTime: 1,
    visibleRadiusM: 100,
    activationRadiusM: 100,
    resourceVision: {
      flagId: "destination-flag",
      flagName: "Destination Flag",
      destinationKind: "flag",
      center: { lat: 35.101, lon: -106.602 },
      movementLeashRadiusM: 100,
      paddingM: 25,
      radiusM: 125
    },
    waterHighlights: [],
    nodes: [],
    repeatableNodes: []
  };
}

function destinationFlagVisited(): ServerMessage {
  return {
    type: "FLAG_VISITED",
    requestId: "flag-request",
    flagId: "destination-flag",
    player: destinationPlayer(),
    resourceVisionRevision:
      DESTINATION_AUTHORITY.resourceVisionRevision
  };
}

function nextDestinationFlagVisited(): ServerMessage {
  return {
    type: "FLAG_VISITED",
    requestId: "next-flag-request",
    flagId: "next-destination-flag",
    player: {
      ...destinationPlayer(),
      zoneId: "world:NM:next-destination",
      lat: 35.202,
      lon: -106.703,
      anchorLat: 35.202,
      anchorLon: -106.703,
      movementRevision: 2,
      relocationRevision: DESTINATION_AUTHORITY.relocationRevision + 1,
      currentFlagId: "next-destination-flag"
    },
    resourceVisionRevision:
      DESTINATION_AUTHORITY.resourceVisionRevision + 1
  };
}

function destinationCityVisited(): ServerMessage {
  return {
    type: "CITY_VISITED",
    requestId: "city-request",
    cityId: "destination-city",
    player: destinationPlayer(),
    resourceVisionRevision:
      DESTINATION_AUTHORITY.resourceVisionRevision
  };
}

function destinationTravelResult(): ServerMessage {
  return {
    type: "TRAVEL_RESULT",
    requestId: "manor-request",
    kind: "manor_jump",
    success: true,
    message: "Jumped to manor.",
    player: destinationPlayer(),
    resourceVisionRevision:
      DESTINATION_AUTHORITY.resourceVisionRevision
  };
}

function destinationSalonExited(): ServerMessage {
  return {
    type: "SALON_EXITED",
    requestId: "salon-exit",
    player: destinationPlayer()
  };
}

function manorExitPlayer(overrides: Partial<ReturnType<typeof destinationPlayer>> = {}) {
  return {
    ...destinationPlayer(),
    relocationRevision: 1,
    ...overrides
  };
}

function manorEnteredMessage(): ServerMessage {
  return {
    type: "MANOR_ENTERED",
    manorId: "manor-1",
    manorSessionId: "manor-session-1",
    displayColor: null,
    position: {
      x: 500,
      y: 790,
      targetX: null,
      targetY: null,
      moving: false,
      revision: 0
    },
    movementSequence: 0,
    serverTime: 1,
    spaceId: "manor_main_room",
    accessSource: "OWNER",
    storage: null
  };
}

function destinationPlayer() {
  return {
    playerId: DESTINATION_AUTHORITY.playerId,
    username: "Scout",
    displayColor: null,
    regionCode: "NM",
    zoneId: "world:NM:destination",
    lat: 35.101,
    lon: -106.602,
    anchorLat: 35.101,
    anchorLon: -106.602,
    moveLeashRadiusM: 100,
    movementRevision: 1,
    relocationRevision: DESTINATION_AUTHORITY.relocationRevision,
    targetLat: null,
    targetLon: null,
    moving: false,
    currentFlagId: "destination-flag",
    online: true,
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

function inventoryWithLeather(
  quantity: number,
  revision = quantity
): PlayerInventorySnapshot {
  const occupiedStacks = Array.from({ length: 15 }, (_, index) => ({
    playerId: "player-1",
    resourceType: "wood" as const,
    variant: null,
    quantity: 250,
    stackId: `wood-stack-${index}`,
    slotIndex: index + 1,
    manualSplit: true
  }));
  return {
    playerId: "player-1",
    revision,
    items: [
      ...(quantity > 0 ? [{
        playerId: "player-1",
        resourceType: "leather" as const,
        variant: null,
        quantity,
        stackId: "leather-stack",
        slotIndex: 0,
        manualSplit: false
      }] : []),
      ...occupiedStacks
    ],
    totals: { ...emptyInventoryTotals(), wood: 3_750, leather: quantity },
    unlockedSlots: 16
  };
}

function leatherDrop(quantity: number): DroppedItemSnapshot {
  return {
    dropId: "11111111-1111-4111-8111-111111111111",
    droppedBy: "player-2",
    regionCode: "US-NM",
    itemId: "leather",
    variant: null,
    quantity,
    status: "active",
    lat: 35,
    lon: -106,
    createdAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2026-07-25T00:10:00.000Z",
    pickedUpBy: null,
    pickedUpAt: null
  };
}

function dungeonSnapshotUpdate(): ServerMessage {
  return {
    type: "DUNGEON_SNAPSHOT",
    snapshot: {
      snapshotKind: "full",
      sessionId: "dungeon-session-1",
      spaceId: "dungeon-room-1",
      roomWidth: 1_000,
      roomHeight: 1_000,
      player: { x: 500, y: 500 },
      objects: [],
      portalLocks: {}
    }
  } as unknown as ServerMessage;
}

function canonicalWorldLocationSnapshot(): ServerMessage {
  return {
    type: "PLAYER_LOCATION_SNAPSHOT",
    location: {
      kind: "world",
      regionCode: "US-NM",
      zoneId: "world:US-NM:test",
      position: { lat: 35, lon: -106 },
      revision: 2
    }
  };
}

function greenhouseInteriorLocation(): ServerMessage {
  return {
    type: "PLAYER_LOCATION_SNAPSHOT",
    location: {
      kind: "interior",
      locationType: "greenhouse",
      locationId: "greenhouse-1",
      instanceId: "greenhouse:greenhouse-1",
      spaceId: "greenhouse_main_room",
      position: { x: 500, y: 790 },
      revision: 2
    }
  } as unknown as ServerMessage;
}

function greenhouseState(requestId: string): ServerMessage {
  return {
    type: "GREENHOUSE_STATE",
    requestId,
    state: {
      greenhouse: { greenhouseId: "greenhouse-1" },
      serverTime: 1,
      waterBucketGallons: 0,
      gardeningBucketGallons: 0,
      inventory: {
        playerId: "player-1",
        revision: 1,
        items: [],
        totals: emptyInventoryTotals()
      }
    }
  } as unknown as ServerMessage;
}

function cisternWarrensEntrance(): DungeonEntranceSnapshot {
  return {
    entranceId: "cistern-warrens-entrance-1",
    dungeonId: "cistern_warrens",
    sewerId: "cistern-warrens-1",
    structureId: "cistern-warrens-structure-1",
    portalId: "cistern-warrens:cistern-warrens-1:world-to-entrance",
    portalRevision: "portal-revision-1",
    interactionLabel: "Enter Cistern Warrens",
    cityId: "city-1",
    cityName: "Test City",
    name: "Cistern Warrens Entrance",
    description: "A stairway descends beneath the city.",
    regionCode: "US-NM",
    lat: 35,
    lon: -106,
    interactionRadiusM: 20,
    footprintRadiusM: 8,
    presentation: "stairs",
    assetKey: null
  };
}

function playerResourcesUpdated(inventory: PlayerInventorySnapshot): ServerMessage {
  return {
    type: "PLAYER_RESOURCES_UPDATED",
    playerId: inventory.playerId,
    inventory,
    serverTime: 1
  } as ServerMessage;
}

function deerRewardGranted(inventory: PlayerInventorySnapshot): ServerMessage {
  return {
    type: "COMBAT_REWARD_GRANTED",
    settlementKey: "deer:defeat:1",
    playerId: inventory.playerId,
    items: [{ itemId: "leather", quantity: 1 }],
    drops: [],
    gold: 15,
    walletGold: "15",
    walletVersion: "1",
    inventory,
    cityCoins: 0,
    cityId: null,
    cityTreasuryBalance: null,
    cityContribution: null
  };
}

function welcomeWithWallet(
  gold: string,
  revision: string
): Extract<ServerMessage, { type: "WELCOME" }> {
  return {
    type: "WELCOME",
    playerId: "player-1",
    username: "Scout",
    spawn: { lat: 35, lon: -106 },
    anchor: { lat: 35, lon: -106 },
    moveLeashRadiusM: 100,
    flagClaimRadiusM: 100,
    playerSpeedMps: 4,
    serverTickHz: 20,
    regionCode: "US-NM",
    zoneId: "zone-1",
    developerCapabilities: [],
    wallet: { playerId: "player-1", gold, revision },
    serverTime: 1
  };
}

function strategicWelcome(): Extract<ServerMessage, { type: "WELCOME" }> {
  return {
    ...welcomeWithWallet("0", "1"),
    connectionId: "connection-1",
    connectionGeneration: 1,
    gameplayViewGeneration: 1,
    relocationRevision: 1,
    resourceVisionRevision: 1,
    protocol: {
      protocolId: "ash-atlas",
      minVersion: 3,
      maxVersion: 3,
      version: 3,
      capabilities: [
        "welcome-protocol-metadata",
        "client-suspend",
        "scoped-flag-snapshots",
        "viewport-flag-loading-v1"
      ]
    }
  };
}

function planningSiegeState(
  locationState: MilitaryUnitGroupSnapshot["locationState"] = "DEPLOYED_FIELD",
  ownerPlayerId = "player-1"
): ServerMessage {
  const group: MilitaryUnitGroupSnapshot = {
    groupId: "siege-1", ownerPlayerId, unitType: "field_ballista",
    memberUnitIds: ["siege-unit-1"], memberCount: 1, currentHp: 100, maxHp: 100,
    locationState, stationCityId: null, warCampId: null, lat: 0, lon: 0,
    targetFlagId: null, nextFireAt: null, packingCompletesAt: null, revision: "1"
  };
  const unit: MilitaryUnitSnapshot = {
    unitId: "siege-unit-1", ownerPlayerId, unitType: "field_ballista", homeCityId: "city-1",
    currentHp: 100, maxHp: 100, status: "available", locationState,
    stationCityId: null, warCampId: null, lat: 0, lon: 0, groupId: "siege-1",
    nextRecoveryAt: null, nextFireAt: null, targetFlagId: null, packingCompletesAt: null,
    revision: "1", createdAt: "2026-01-01T00:00:00.000Z"
  };
  const message = militaryIndustryState();
  if (message.type !== "MILITARY_INDUSTRY_STATE") throw new Error("Wrong fixture");
  return { ...message, snapshot: { ...message.snapshot, groups: [group], units: [unit] } };
}

function militaryIndustryState(): ServerMessage {
  return {
    type: "MILITARY_INDUSTRY_STATE",
    requestId: "military-request-1",
    snapshot: {
      lodge: null,
      personnel: [],
      units: [],
      groups: [],
      warCamp: null,
      bomberChannel: null,
      jobs: [],
      queueCapacity: 5,
      serverTime: Date.now(),
      fieldBallistaKitEnabled: false,
      fieldBallistaEnabled: true
    }
  } as ServerMessage;
}

function strategicVisionSnapshot(
  center: { lat: number; lon: number },
  relocationRevision: number,
  gameplayViewGeneration: number,
  flagIds: readonly string[]
) {
  return {
    authority: {
      center,
      radiusM: 3_000,
      relocationRevision,
      gameplayViewGeneration
    },
    flags: flagIds.map((flagId) => ({
      controlType: "personal" as const,
      id: flagId,
      ownerId: "owner",
      name: flagId,
      lat: center.lat,
      lon: center.lon,
      packageId: null,
      elevationM: null,
      terrainClass: null,
      biome: null,
      ecoregion: null,
      claimRadiusM: 500,
      cityId: null,
      createdAt: new Date(0).toISOString()
    })),
    cities: [],
    landmarks: [],
    flagSetRevision: 42,
    complete: true
  };
}

function devGrant(inventory: PlayerInventorySnapshot): ServerMessage {
  return {
    type: "DEV_ASSETS_GRANTED",
    requestId: "grant-1",
    replayed: false,
    walletGold: "0",
    inventory,
    cityCoins: null,
    grants: []
  };
}

function itemDrop(inventory: PlayerInventorySnapshot): ServerMessage {
  return {
    type: "ITEM_DROP_RESULT",
    requestId: "drop-1",
    drop: leatherDrop(10),
    droppedQuantity: 10,
    inventory,
    replayed: false,
    serverTime: 1,
    message: "Dropped"
  } as ServerMessage;
}

function pickupResult(
  inventory: PlayerInventorySnapshot,
  pickedUpQuantity: number,
  remainingQuantity: number
): ServerMessage {
  return {
    type: "DROPPED_ITEM_PICKUP_RESULT",
    requestId: `pickup-${pickedUpQuantity}`,
    itemId: "leather",
    requestedQuantity: pickedUpQuantity,
    drop: leatherDrop(remainingQuantity),
    pickedUpQuantity,
    remainingQuantity,
    removed: remainingQuantity === 0,
    inventory,
    replayed: false,
    serverTime: 1,
    message: "Picked up"
  };
}

function marketMutation(revision = 70): ServerMessage {
  return {
    type: "MARKET_MUTATION_RESULT",
    requestId: "market-1",
    result: {
      action: "claim",
      requestId: "market-1",
      replayed: false,
      order: null,
      trades: [],
      claimedItems: "1",
      claimedGold: "0",
      claimedEquipment: 0,
      equipmentListing: null,
      player: {
        walletGold: "0",
        walletVersion: "0",
        activeOrders: [],
        recentOrders: [],
        recentFills: [],
        collection: { items: [], equipment: [], gold: "0" }
      }
    },
    inventory: inventoryWithLeather(70, revision)
  };
}

function packageClaim(inventory: PlayerInventorySnapshot): ServerMessage {
  return {
    type: "PLAYER_PACKAGE_CLAIM_RESULT",
    requestId: "package-claim-1",
    replayed: false,
    walletGold: "0",
    cityCredit: null,
    inventory,
    equipment: {
      playerId: "player-1",
      instances: [],
      active: emptyEquipmentSlots(null)
    } as never,
    package: {
      packageId: "package-1",
      campaignId: "campaign-1",
      title: "Supplies",
      message: "",
      sender: "Ash Atlas",
      kind: "admin",
      senderPlayerId: null,
      status: "claimed",
      readAt: null,
      firstClaimedAt: "2026-07-26T00:00:00.000Z",
      claimedAt: "2026-07-26T00:00:00.000Z",
      createdAt: "2026-07-26T00:00:00.000Z",
      revision: "2",
      items: []
    },
    lines: [],
    message: "Package opened."
  };
}

function protectionSnapshot(revision: number): ServerMessage {
  return {
    type: "INVENTORY_PROTECTION_SNAPSHOT",
    protection: {
      playerId: "player-1",
      revision,
      materialPolicies: [],
      uniqueItems: [],
      stackAllocations: []
    }
  };
}
