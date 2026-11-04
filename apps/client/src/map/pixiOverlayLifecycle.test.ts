import { describe, expect, it, vi } from "vitest";
import { Container, Texture } from "pixi.js";
import type { FlagSnapshot } from "@ash-atlas/shared";
import { WORLD_PNG_PRESENTATION } from "./worldPngPresentation.js";

import {
  authoritativeCollectibleForHit,
  createAnimationFrameLoop,
  desiredMobIdsForPresentation,
  FLAG_BURNING_ARTWORK_OFFSET_Y_PX,
  FLAG_HEALTH_BAR_HEIGHT_PX,
  FLAG_HEALTH_BAR_LABEL_GAP_PX,
  FLAG_KINGDOM_EMBLEM_ARTWORK_Y_PX,
  FLAG_MARKER_HEIGHT_PX,
  FLAG_MARKER_HIT_RADIUS_PX,
  flagHealthBarOffsetBelowAnchor,
  flagsSignature,
  kingdomSeatMarkerAlpha,
  kingdomSeatMarkerPosition,
  KINGDOM_SEAT_HIT_RADIUS_PX,
  KINGDOM_SEAT_MARKER_SIZE_PX,
  paintMapSynchronizedOverlayFrame,
  paintSynchronizedOverlayFrame,
  loadPresentationTexture,
  SALON_STRUCTURE_HIT_CENTER_Y_PX,
  SALON_STRUCTURE_HIT_RADIUS_PX,
  settleWithinBudget,
  shouldRenderFlagHealthBar,
  startAnimationFrameLoop
} from "./pixiOverlay.js";

describe("Pixi overlay animation lifecycle", () => {
  it("retains committed mobs while a replacement presentation is preparing", () => {
    const retained = [
      { entityId: "mob-old", kind: "mob" as const },
      { entityId: "player-1", kind: "player" as const }
    ];
    const replacement = [
      { entityId: "mob-new", kind: "mob" as const },
      {
        entityId: "dog-new",
        kind: "mob" as const,
        companion: {
          ownerPlayerId: "player-1",
          dogId: "dog-1",
          species: "trail_hound" as const,
          mode: "play" as const,
        },
      },
      {
        entityId: "goblin-defender:new",
        kind: "mob" as const,
        npcFaction: {
          cityId: "city-1",
          cityName: "Goblin Village",
          culture: "goblin" as const,
          role: "archer" as const,
          presentationKey: "goblin_archer",
          relation: "neutral" as const,
          protected: true as const
        }
      },
      { entityId: "player-1", kind: "player" as const }
    ];

    expect([...desiredMobIdsForPresentation(false, replacement, retained)])
      .toEqual(["mob-old", "dog-new", "goblin-defender:new"]);
    expect([...desiredMobIdsForPresentation(true, replacement, retained)])
      .toEqual(["mob-new", "dog-new", "goblin-defender:new"]);
  });

  it("degrades a missing presentation asset without rejecting overlay startup", async () => {
    const onFailure = vi.fn();

    await expect(loadPresentationTexture(
      "rare-mob.png",
      vi.fn(async () => { throw new Error("missing"); }),
      Texture.EMPTY,
      onFailure
    )).resolves.toBe(Texture.EMPTY);
    expect(onFailure).toHaveBeenCalledWith("rare-mob.png", expect.any(Error));
  });

  it("bounds local appearance settlement without rejecting a usable fallback", async () => {
    vi.useFakeTimers();
    try {
      const result = settleWithinBudget(new Promise(() => undefined), 500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(false);
      await expect(settleWithinBudget(Promise.resolve(), 500)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not return a stale hitbox collectible absent from rendered authority", () => {
    const current = {
      id: "tree:current"
    } as Parameters<typeof authoritativeCollectibleForHit>[0][number];

    expect(authoritativeCollectibleForHit([current], "tree:current")).toBe(current);
    expect(authoritativeCollectibleForHit([], "tree:removed")).toBeNull();
  });
  it("keeps the Seat visibly larger without an oversized hit target", () => {
    expect(KINGDOM_SEAT_MARKER_SIZE_PX / FLAG_MARKER_HEIGHT_PX).toBeGreaterThanOrEqual(5);
    expect(KINGDOM_SEAT_MARKER_SIZE_PX / FLAG_MARKER_HEIGHT_PX).toBeLessThanOrEqual(6);
    expect(KINGDOM_SEAT_HIT_RADIUS_PX).toBeGreaterThan(FLAG_MARKER_HIT_RADIUS_PX);
    expect(KINGDOM_SEAT_HIT_RADIUS_PX).toBeLessThan(KINGDOM_SEAT_MARKER_SIZE_PX);
    expect(kingdomSeatMarkerAlpha("under_construction")).toBeLessThan(1);
    expect(kingdomSeatMarkerAlpha("complete")).toBe(1);
  });

  it("centers the Salon hit target over its visible building art", () => {
    // Authored rectangular target replaces the former circular building-center radius.
    expect(SALON_STRUCTURE_HIT_CENTER_Y_PX).toBeCloseTo((0.492 - 0.7531968700369506) * 61.9);
    expect(SALON_STRUCTURE_HIT_RADIUS_PX).toBe(0);
    expect(WORLD_PNG_PRESENTATION.cityStructures.salon.hitGeometry).toMatchObject({
      shape: "rectangle", centerX: 0.531, centerY: 0.492, width: 0.958, height: 1
    });
  });

  it("invalidates retained flag presentation when the upgrade tier or name changes", () => {
    const base = {
      id: "flag-a",
      name: "North Flag",
      controlType: "personal",
      ownerId: "owner",
      lat: 35,
      lon: -106,
      claimRadiusM: 1000,
      cityId: null,
      createdAt: "2026-07-26T00:00:00.000Z"
    } as Parameters<typeof flagsSignature>[0][number];
    expect(flagsSignature([{ ...base, upgradeTier: "base" }]))
      .not.toBe(flagsSignature([{ ...base, upgradeTier: "stone" }]));
    expect(flagsSignature([{ ...base, upgradeTier: "stone" }]))
      .not.toBe(flagsSignature([{ ...base, name: "Renamed", upgradeTier: "stone" }]));
    expect(FLAG_MARKER_HIT_RADIUS_PX).toBe(24);
  });

  it("hides pristine Flag health and reveals damage or burning", () => {
    const pristine = {
      id: "flag-health",
      controlType: "personal",
      ownerId: "owner",
      cityId: null,
      health: 100,
      maximumHealth: 100,
      burning: false
    } as FlagSnapshot;
    expect(shouldRenderFlagHealthBar(pristine)).toBe(false);
    expect(shouldRenderFlagHealthBar({ ...pristine, health: 99 })).toBe(true);
    expect(shouldRenderFlagHealthBar({ ...pristine, burning: true })).toBe(true);
    for (const upgradeTier of ["base", "stone", "tower"] as const) {
      expect(shouldRenderFlagHealthBar({
        ...pristine,
        upgradeTier,
        health: 190,
        maximumHealth: 200
      })).toBe(true);
    }
  });

  it("keeps structure health bars below each authored Flag anchor", () => {
    expect(flagHealthBarOffsetBelowAnchor({ anchorKind: "flag", upgradeTier: "base" }))
      .toBeGreaterThan(0);
    expect(flagHealthBarOffsetBelowAnchor({ anchorKind: "flag", upgradeTier: "tower" }))
      .toBeGreaterThan(0);
    expect(flagHealthBarOffsetBelowAnchor({ anchorKind: "buoy", upgradeTier: "base" }))
      .toBeGreaterThan(0);
    expect(FLAG_HEALTH_BAR_HEIGHT_PX + FLAG_HEALTH_BAR_LABEL_GAP_PX).toBe(7);
  });

  it("keeps marker interaction geometry while repositioning taller-art adornments", () => {
    expect(FLAG_MARKER_HEIGHT_PX).toBe(25);
    expect(FLAG_MARKER_HIT_RADIUS_PX).toBe(24);
    expect(FLAG_KINGDOM_EMBLEM_ARTWORK_Y_PX).toBe(-25.8125);
    expect(FLAG_BURNING_ARTWORK_OFFSET_Y_PX).toBe(-13.8125);
  });

  it("projects a Castle from its physical coordinates with a legacy fallback", () => {
    expect(kingdomSeatMarkerPosition({
      lat: 35,
      lon: -106,
      kingdomSeatLat: 35.003,
      kingdomSeatLon: -106.004
    })).toEqual({ lat: 35.003, lon: -106.004 });
    expect(kingdomSeatMarkerPosition({ lat: 35, lon: -106 }))
      .toEqual({ lat: 35, lon: -106 });
  });

  it("paints only after the current map-space coordinates are applied", () => {
    const calls: string[] = [];

    paintSynchronizedOverlayFrame(
      () => calls.push("update transform"),
      () => calls.push("paint overlay")
    );

    expect(calls).toEqual(["update transform", "paint overlay"]);
  });

  it("reprojects characters before painting a map interaction frame", () => {
    const calls: string[] = [];

    paintMapSynchronizedOverlayFrame(
      () => calls.push("update static transform"),
      () => calls.push("reproject characters"),
      () => calls.push("paint overlay")
    );

    expect(calls).toEqual([
      "update static transform",
      "reproject characters",
      "paint overlay"
    ]);
  });

  it("does not move a local-player sibling when the gameplay world transforms", () => {
    const root = new Container();
    const gameplayWorldLayer = new Container();
    const localPlayerLayer = new Container();
    const localPlayer = new Container();
    root.addChild(gameplayWorldLayer, localPlayerLayer);
    localPlayerLayer.addChild(localPlayer);
    localPlayer.position.set(640, 360);
    const origin = localPlayer.getGlobalPosition();

    gameplayWorldLayer.position.set(900, -300);
    gameplayWorldLayer.scale.set(1.75);
    gameplayWorldLayer.rotation = 0.25;

    expect(localPlayer.getGlobalPosition()).toEqual(origin);
  });

  it("leaves one render loop after a Strict Mode cleanup and remount", () => {
    const scheduler = new FakeAnimationFrameScheduler();
    const staleDraw = vi.fn();
    const stopStaleLoop = startAnimationFrameLoop(staleDraw, scheduler);
    const staleCallback = scheduler.onlyCallback();

    stopStaleLoop();
    staleCallback(0);
    expect(staleDraw).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);

    const activeDraw = vi.fn();
    const stopActiveLoop = startAnimationFrameLoop(activeDraw, scheduler);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.runOnlyFrame();
    expect(activeDraw).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount()).toBe(1);

    stopActiveLoop();
    stopActiveLoop();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("pauses and resumes exactly one world loop across repeated manor visits", () => {
    const scheduler = new FakeAnimationFrameScheduler();
    const draw = vi.fn();
    const loop = createAnimationFrameLoop(draw, scheduler);
    for (let cycle = 0; cycle < 50; cycle += 1) {
      loop.setActive(false);
      expect(scheduler.pendingCount()).toBe(0);
      loop.setActive(true);
      loop.setActive(true);
      expect(scheduler.pendingCount()).toBe(1);
      scheduler.runOnlyFrame();
      expect(scheduler.pendingCount()).toBe(1);
    }
    expect(draw).toHaveBeenCalledTimes(50);
    loop.stop();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("replaces a browser-discarded frame callback with one fresh callback on resume", () => {
    const scheduler = new FakeAnimationFrameScheduler();
    const draw = vi.fn();
    const loop = createAnimationFrameLoop(draw, scheduler);
    const discardedCallback = scheduler.onlyCallback();

    loop.restart();

    expect(scheduler.pendingCount()).toBe(1);
    discardedCallback(0);
    expect(draw).not.toHaveBeenCalled();
    scheduler.runOnlyFrame();
    expect(draw).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount()).toBe(1);
    loop.stop();
  });
});

class FakeAnimationFrameScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  cancelAnimationFrame = (id: number): void => {
    this.callbacks.delete(id);
  };

  pendingCount(): number {
    return this.callbacks.size;
  }

  onlyCallback(): FrameRequestCallback {
    expect(this.callbacks.size).toBe(1);
    return [...this.callbacks.values()][0]!;
  }

  runOnlyFrame(): void {
    const [id, callback] = [...this.callbacks.entries()][0]!;
    this.callbacks.delete(id);
    callback(0);
  }
}
