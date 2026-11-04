import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASIC_ATTACK_RANGE_M,
  distanceMeters,
  moveToward,
  type ServerMessage
} from "@ash-atlas/shared";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import { CombatEngine } from "./combat/combatEngine.js";
import { resourceVisionForFlag } from "./collectibles.js";
import { populationZoneV2IdForPoint } from "./populationZonesV2Geometry.js";
import {
  packageIdForPosition,
  zoneIdForPosition
} from "./spatialZones.js";
import { GameState } from "./state.js";
import type { WorldCommandInput } from "./worldCommandQueue.js";
import { WorldRuntime } from "./worldRuntime.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("WorldRuntime", () => {
  afterEach(() => vi.restoreAllMocks());
  it("does not publish movement-settled repeatedly for a stationary subscription", async () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const settled = vi.fn();
    setup.runtime.subscribeMovementSettled("p1", settled);

    setup.runtime.tick(0.02);
    setup.runtime.tick(0.02);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
  });

  it("publishes movement-settled once after a subscribed player moves", async () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const settled = vi.fn();
    setup.runtime.subscribeMovementSettled("p1", settled);

    setup.gameState.setTarget("p1", east(10));
    setup.runtime.tick(1);
    await Promise.resolve();
    setup.runtime.tick(1);
    await Promise.resolve();

    expect(settled).toHaveBeenCalledOnce();
  });

  it("heals by the next combat tick after authoritative movement enters tree range", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", east(55));
    setCombatHealth(setup.combat, "p1", 90);
    setup.combat.replaceGivingTreeSource("zone", [
      { id: "tree-a", ...origin }
    ]);
    setup.gameState.setTarget("p1", origin);

    setup.runtime.tick(0.05);
    expect(distanceMeters(setup.gameState.getPlayer("p1")!.position, origin))
      .toBeLessThanOrEqual(50);
    expect(setup.combat.entity("p1")?.currentHealth).toBe(90);

    setup.runtime.tick(0.05);
    expect(setup.combat.entity("p1")?.currentHealth).toBe(93);
  });

  it("keeps visibility-zone subscriptions centered on the anchor across a physical zone boundary", () => {
    const setup = createRuntime();
    const anchor = { lat: 35.1, lon: -106.0001 };
    const target = moveToward(anchor, { lat: anchor.lat, lon: anchor.lon + 0.02 }, 100);
    setup.addPlayer("p1", anchor);
    const anchorRegionCode = setup.gameState.getPlayer("p1")!.regionCode;
    const anchorMob = setup.combat.spawnMob({
      entityId: "mob:anchor-side-of-boundary",
      archetype: "training_dummy",
      position: anchor,
      regionCode: anchorRegionCode,
      zoneId: zoneIdForPosition(anchor)
    });
    setup.runtime.tick(0);
    const anchorInterest = [...setup.gameState.getGameplayViewCircle("p1")!.eligibleZoneIds];

    expect(setup.registry.records()[0]?.interestZoneIds).toEqual(anchorInterest);
    setup.gameState.setTarget("p1", target);
    setup.runtime.tick(1);

    const connection = setup.registry.records()[0]!;
    expect(zoneIdForPosition(target)).not.toBe(zoneIdForPosition(anchor));
    expect(connection.zoneId).toBe(zoneIdForPosition(target));
    expect(connection.interestZoneIds).toEqual(anchorInterest);
    expect(setup.gameState.getGameplayViewCircle("p1")?.center).toEqual(anchor);
    expect(setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1"))
      .toContain(anchorMob.entityId);
  });

  it("starts Population V2-style combat across an internal package boundary inside the gameplay view", () => {
    const setup = createRuntime();
    const anchor = { lat: 35.1, lon: -106.000_001 };
    const target = { lat: 35.1, lon: -105.999_999 };
    setup.addPlayer("p1", anchor);
    expect(zoneIdForPosition(target)).not.toBe(zoneIdForPosition(anchor));
    const mob = setup.combat.spawnMob({
      entityId: "mob:population-boundary",
      archetype: "wolf",
      position: target,
      regionCode: packageIdForPosition(target),
      zoneId: zoneIdForPosition(target),
      originFlagId: null,
      populationAuthority: {
        ownerToken: "00000000-0000-4000-8000-000000000285",
        fencingGeneration: 1,
        cutoverRevision: 1
      }
    });

    setup.runtime.enqueue(command(
      "p1",
      setup.connectionIds.get("p1")!,
      "population-boundary-attack",
      { kind: "start-attack", targetEntityId: mob.entityId }
    ));
    setup.runtime.tick(0);

    expect(messages(setup.sockets.get("p1")!)).toContainEqual(
      expect.objectContaining({
        type: "COMBAT_STARTED",
        requestId: "population-boundary-attack"
      })
    );
  });

  it("resyncs once for repeated attacks on a target outside current authority", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const player = setup.gameState.getPlayer("p1")!;
    const outside = setup.combat.spawnMob({
      entityId: "mob:outside-current-authority",
      archetype: "wolf",
      position: east(700),
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(player.position),
      originFlagId: null
    });
    const connectionId = setup.connectionIds.get("p1")!;
    for (const requestId of ["outside-first", "outside-repeat"]) {
      setup.runtime.enqueue(command("p1", connectionId, requestId, {
        kind: "start-attack",
        targetEntityId: outside.entityId
      }));
      setup.runtime.tick(0);
    }

    const rejections = messages(setup.sockets.get("p1")!).filter(
      (message) =>
        message.type === "ERROR" &&
        message.code === "COMBAT_TARGET_NO_LONGER_AVAILABLE"
    );
    expect(rejections).toHaveLength(2);
    expect(rejections[0]).toMatchObject({
      details: {
        targetEntityId: outside.entityId,
        gameplayViewGeneration: expect.any(Number),
        combatValidationPredicate: "pve-outside-authoritative-view"
      }
    });
    expect(setup.combat.metricsSnapshot().resyncRequests).toBe(1);
  });

  it("revokes final runtime authority outside full per-player and global command queues", () => {
    const manorDisconnect = vi.fn();
    const setup = createRuntime(
      {
        WORLD_COMMAND_QUEUE_GLOBAL_MAX: "3",
        WORLD_COMMAND_QUEUE_PER_PLAYER_MAX: "2"
      },
      { get: () => ({ sessionId: "manor-session-p1" }), disconnect: manorDisconnect }
    );
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(10));
    const p1Connection = setup.connectionIds.get("p1")!;
    const p1 = setup.gameState.getPlayer("p1")!;
    setup.gameState.setTarget("p1", east(500));
    const mobPosition = east(50);
    const mob = setup.combat.spawnMob({
      archetype: "wolf",
      position: mobPosition,
      regionCode: p1.regionCode,
      zoneId: zoneIdForPosition(p1.position)
    });
    setup.combat.startAttack({
      attackerId: "p1",
      targetEntityId: mob.entityId,
      requestId: "pursuit",
      accountId: "account-p1",
      connectionId: p1Connection
    });
    expect(setup.runtime.enqueue(command("p1", p1Connection, "one", { kind: "cancel-attack" })))
      .toMatchObject({ accepted: true });
    expect(setup.runtime.enqueue(command("p1", p1Connection, "two", { kind: "cancel-attack" })))
      .toMatchObject({ accepted: true });
    expect(setup.runtime.enqueue(command("p1", p1Connection, "player-full", { kind: "cancel-attack" })))
      .toEqual({ accepted: false, reason: "player-overflow" });
    expect(setup.runtime.enqueue(command(
      "p2",
      setup.connectionIds.get("p2")!,
      "global-last",
      { kind: "cancel-attack" }
    ))).toMatchObject({ accepted: true });
    expect(setup.runtime.enqueue(command(
      "overflow",
      "missing",
      "global-full",
      { kind: "cancel-attack" }
    ))).toEqual({ accepted: false, reason: "global-overflow" });

    setup.registry.remove(p1Connection);
    expect(setup.runtime.revokeConnectionAuthority("p1", p1Connection)).toBe("revoked");

    expect(setup.runtime.commands.depth).toBe(3);
    expect(setup.gameState.getPlayer("p1")).toMatchObject({ online: false, target: null });
    expect(setup.gameState.isWorldPresent("p1")).toBe(false);
    expect(setup.combat.entity("p1")).toBeNull();
    expect(manorDisconnect).toHaveBeenCalledWith("p1", "manor-session-p1");
  });

  it("ignores an old close generation after a replacement becomes authoritative", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const oldConnectionId = setup.connectionIds.get("p1")!;
    const replacementSocket = socket();
    const replacement = setup.registry.addWithReplacement({
      accountId: "account-p1",
      playerId: "p1",
      username: "p1",
      regionCode: "GLOBAL",
      zoneId: zoneIdForPosition(origin),
      socket: replacementSocket
    });
    setup.combat.rotatePlayerAuthority("p1", "account-p1", replacement.connectionId);

    expect(setup.runtime.revokeConnectionAuthority("p1", oldConnectionId)).toBe("stale-connection");
    expect(setup.registry.activeConnectionIdForPlayer("p1")).toBe(replacement.connectionId);
    expect(setup.gameState.getPlayer("p1")?.online).toBe(true);
    expect(setup.gameState.isWorldPresent("p1")).toBe(true);
    expect(setup.combat.entity("p1")).not.toBeNull();
  });

  it("allows idempotent final revocation after a late world transition completes", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const transition = setup.runtime.beginPlayerWorldTransition("p1")!;
    setup.registry.remove(connectionId);

    expect(setup.runtime.revokeConnectionAuthority("p1", connectionId)).toBe("revoked");
    setup.gameState.markOnlinePreservingView("p1");
    expect(setup.runtime.endPlayerWorldTransition("p1", transition)).toBe(false);
    expect(setup.runtime.revokeConnectionAuthority("p1", connectionId)).toBe("revoked");

    expect(setup.gameState.getPlayer("p1")).toMatchObject({ online: false, target: null });
    expect(setup.gameState.isWorldPresent("p1")).toBe(false);
    expect(setup.combat.entity("p1")).toBeNull();
  });

  it("blocks mutating commands and cleanup waiters behind an exact-token player world transition", async () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const token = setup.runtime.beginPlayerWorldTransition("p1");
    expect(token).not.toBeNull();
    expect(setup.runtime.beginPlayerWorldTransition("p1")).toBeNull();
    const envelope = { playerId: "p1", accountId: "account-p1", connectionId };
    const blocked: WorldCommandInput[] = [
      { ...envelope, requestId: "attack", kind: "start-attack", targetEntityId: "mob:1" },
      { ...envelope, requestId: "taunt", kind: "universal-taunt" }
    ];
    for (const input of blocked) {
      expect(setup.runtime.enqueue(input)).toEqual({ accepted: false, reason: "transition-pending" });
    }
    expect(setup.runtime.enqueue({
      ...envelope,
      requestId: "move",
      kind: "move",
      target: east(1)
    })).toMatchObject({ accepted: true, buffered: true });
    let cleanupReleased = false;
    const cleanup = setup.runtime.waitForPlayerWorldTransition("p1").then(() => {
      cleanupReleased = true;
    });
    expect(setup.runtime.endPlayerWorldTransition("p1", Symbol("stale"))).toBe(false);
    await Promise.resolve();
    expect(cleanupReleased).toBe(false);
    expect(setup.runtime.hasPlayerWorldTransition("p1")).toBe(true);
    expect(setup.runtime.endPlayerWorldTransition("p1", token!)).toBe(true);
    await cleanup;
    expect(cleanupReleased).toBe(true);
    expect(setup.runtime.enqueue({
      ...envelope,
      requestId: "move-after",
      kind: "move",
      target: east(1)
    })).toMatchObject({ accepted: true });
  });

  it("accepts combat immediately after relocation commit while population remains preparing", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const transition =
      setup.runtime.beginPlayerWorldTransition("p1", "travel-population")!;
    const relocationRevision =
      setup.gameState.getPlayer("p1")?.relocationRevision ?? 0;

    setup.runtime.commitPlayerWorldTransition(
      "p1",
      transition,
      relocationRevision
    );
    setup.runtime.beginPopulationPreparation(
      "p1",
      relocationRevision,
      "travel-population"
    );
    setup.runtime.endPlayerWorldTransition(
      "p1",
      transition,
      "committed",
      "authoritative-relocation-committed"
    );

    expect(setup.runtime.enqueue({
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "attack-after-commit",
      kind: "start-attack",
      targetEntityId: "mob:unloaded"
    })).toMatchObject({ accepted: true });
    setup.runtime.tick(0);
    expect(messages(setup.sockets.get("p1")!)).toContainEqual(
      expect.objectContaining({
        type: "ERROR",
        requestId: "attack-after-commit",
        code: "WORLD_AUTHORITY_PREPARING",
        retryable: true,
        details: expect.objectContaining({
          targetEntityId: "mob:unloaded",
          relocationRevision
        })
      })
    );

    setup.runtime.endPopulationPreparation("p1", relocationRevision);
    expect(setup.runtime.enqueue({
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "attack-after-ready",
      kind: "start-attack",
      targetEntityId: "mob:gone"
    })).toMatchObject({ accepted: true });
    setup.runtime.tick(0);
    expect(messages(setup.sockets.get("p1")!)).toContainEqual(
      expect.objectContaining({
        type: "ERROR",
        requestId: "attack-after-ready",
        code: "COMBAT_TARGET_NO_LONGER_AVAILABLE",
        details: expect.objectContaining({
          targetEntityId: "mob:gone",
          relocationRevision
        })
      })
    );
  });

  it("bounds transition waits so shutdown cleanup cannot hang", async () => {
    vi.useFakeTimers();
    try {
      const setup = createRuntime();
      setup.addPlayer("p1", origin);
      setup.runtime.beginPlayerWorldTransition("p1", "stalled");

      const released = setup.runtime.waitForPlayerWorldTransition("p1", {
        timeoutMs: 250
      });
      await vi.advanceTimersByTimeAsync(250);

      await expect(released).resolves.toBe(false);
      expect(setup.runtime.forceReleaseAllPlayerWorldTransitions("shutdown"))
        .toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers pre-commit movement and replays only the newest committed move", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const transition = setup.runtime.beginPlayerWorldTransition("p1", "travel-1")!;
    const firstTarget = east(510);
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-1",
      boundTravelRequestId: "travel-1",
      target: firstTarget
    })).toEqual({ accepted: true, sequence: 0, buffered: true });
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-before-commit",
      boundTravelRequestId: "travel-1",
      target: east(10)
    })).toEqual({ accepted: true, sequence: 0, buffered: true });
    setup.gameState.teleportPlayer("p1", east(500));
    const relocationRevision =
      setup.gameState.getPlayer("p1")!.relocationRevision;
    expect(setup.runtime.commitPlayerWorldTransition(
      "p1",
      transition,
      relocationRevision ?? 0
    )).toBe(true);
    const newestTarget = east(520);
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-2",
      boundTravelRequestId: "travel-1",
      target: firstTarget
    })).toEqual({ accepted: true, sequence: 0, buffered: true });
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-3",
      boundTravelRequestId: "travel-1",
      target: newestTarget
    })).toEqual({ accepted: true, sequence: 0, buffered: true });
    expect(setup.runtime.commands.depth).toBe(0);

    expect(setup.runtime.endPlayerWorldTransition("p1", transition, "committed")).toBe(true);
    expect(setup.runtime.commands.depth).toBe(1);
    setup.runtime.tick(0);

    expect(setup.gameState.getPlayer("p1")?.target).toEqual(newestTarget);
    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "MOVE_ACCEPTED", requestId: "move-3" })
    ]));
    expect(messages(setup.sockets.get("p1")!)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "MOVE_ACCEPTED", requestId: "move-2" })
    ]));
  });

  it("tells the mover its effective walking speed in MOVE_ACCEPTED (base x clamped movement multiplier)", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const multiplier = vi.spyOn(setup.combat, "playerMovementMultiplier").mockReturnValue(0.85);
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "slow-move",
      target: east(30)
    })).toMatchObject({ accepted: true });
    setup.runtime.tick(0);
    const basis = setup.gameState.playerMovementSpeedMps;
    const accepted = messages(setup.sockets.get("p1")!).find((message) =>
      message.type === "MOVE_ACCEPTED" && message.requestId === "slow-move");
    expect(accepted).toMatchObject({ speedMps: expect.closeTo(basis * 0.85, 9) });

    // The tick applies the same product: one step walks speedMps x dt.
    const before = { ...setup.gameState.getPlayer("p1")!.position };
    setup.runtime.tick(0.05);
    const stepM = distanceMeters(before, setup.gameState.getPlayer("p1")!.position);
    expect(stepM).toBeCloseTo(basis * 0.85 * 0.05, 6);
    expect(setup.gameState.effectiveSpeedMps("p1")).toBeCloseTo(basis * 0.85, 9);

    // Clamped to the tick's 0.2..2 range.
    multiplier.mockReturnValue(5);
    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "fast-move",
      target: east(60)
    });
    setup.runtime.tick(0);
    const fast = messages(setup.sockets.get("p1")!).find((message) =>
      message.type === "MOVE_ACCEPTED" && message.requestId === "fast-move");
    expect(fast).toMatchObject({ speedMps: expect.closeTo(basis * 2, 9) });
  });

  it("rejects a fresh movement command while the player is Downed", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    setup.combat["entities"].get("p1")!.lifeState = "downed";

    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "downed-move",
      target: east(20)
    })).toMatchObject({ accepted: true });
    setup.runtime.tick(0);

    expect(setup.gameState.getPlayer("p1")?.target).toBeNull();
    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ERROR", requestId: "downed-move", code: "MOVE_REJECTED" })
    ]));
  });

  describe("action combat SWING", () => {
    function swing(setup: ReturnType<typeof createRuntime>, seq: number, dirX = 1, dirY = 0) {
      return setup.runtime.enqueue({
        kind: "swing",
        playerId: "p1",
        accountId: "account-p1",
        connectionId: setup.connectionIds.get("p1")!,
        requestId: `swing-${seq}`,
        seq,
        dirX,
        dirY,
        lagMs: 0,
        receivedAtMs: performance.now()
      });
    }

    function spawnDummy(setup: ReturnType<typeof createRuntime>, distanceM = 20): string {
      setup.runtime.enqueue({
        kind: "dev-spawn-mob",
        playerId: "p1",
        accountId: "account-p1",
        connectionId: setup.connectionIds.get("p1")!,
        requestId: "spawn-dummy",
        archetype: "training_dummy",
        position: east(distanceM)
      });
      setup.runtime.tick(0.05);
      const spawned = messages(setup.sockets.get("p1")!).find((message) => message.type === "DEV_MOB_SPAWNED");
      if (spawned?.type !== "DEV_MOB_SPAWNED") throw new Error("training dummy did not spawn");
      return spawned.mobEntityId;
    }

    function swingResults(setup: ReturnType<typeof createRuntime>) {
      return messages(setup.sockets.get("p1")!).filter(
        (message): message is Extract<ServerMessage, { type: "SWING_RESULT" }> => message.type === "SWING_RESULT"
      );
    }

    function damageEventsFor(sent: ServerMessage[], targetEntityId: string): unknown[] {
      return sent.flatMap((message) => {
        const events = (message as { state?: { events?: Array<{ type?: string; targetEntityId?: string | null }> } })
          .state?.events;
        return Array.isArray(events)
          ? events.filter((event) => event.type === "DAMAGE" && event.targetEntityId === targetEntityId)
          : [];
      });
    }

    it("routes each deferred SWING_RESULT to its own press's connection, several in flight at once", () => {
      const setup = createRuntime();
      setup.addPlayer("p1", origin);
      const connectionId = setup.connectionIds.get("p1")!;
      const runtime = setup.runtime as unknown as {
        rememberDeferredSwing(playerId: string, requestId: string, origin: { connectionId: string; receivedAtMs: number }): void;
        bufferedSwingConnections: Map<string, Map<string, unknown>>;
      };
      // A sword windup landing at contact plus an early press buffered behind it.
      runtime.rememberDeferredSwing("p1", "swing-1", { connectionId, receivedAtMs: performance.now() });
      runtime.rememberDeferredSwing("p1", "swing-2", { connectionId, receivedAtMs: performance.now() });
      const result = (seq: number) => ({ seq, requestId: `swing-${seq}`, serverTick: 1, comboIndex: 0 as const, nextSwingAtMs: 0, hits: [] });
      setup.runtime.deliverBufferedSwingResult("p1", result(1));
      expect(runtime.bufferedSwingConnections.get("p1")?.has("swing-2")).toBe(true);
      setup.runtime.deliverBufferedSwingResult("p1", result(2));
      expect(swingResults(setup).map((message) => message.requestId)).toEqual(["swing-1", "swing-2"]);
      expect(runtime.bufferedSwingConnections.has("p1")).toBe(false);
    });

    it("answers SWING with a disabled SWING_RESULT while ACTION_COMBAT_ENABLED is off", () => {
      const setup = createRuntime();
      setup.addPlayer("p1", origin);
      swing(setup, 4, 0, 1);
      setup.runtime.tick(0);

      expect(swingResults(setup)).toEqual([
        expect.objectContaining({ requestId: "swing-4", seq: 4, comboIndex: 0, hits: [], rejected: "disabled" })
      ]);
    });

    it("hits a dev-spawned training dummy and ships its DAMAGE event in the same tick", () => {
      // A 1 Hz combat delta slot: any COMBAT_DELTA in the swing tick came from the immediate flush.
      const setup = createRuntime({ ACTION_COMBAT_ENABLED: "true", DEV_TOOLS_ENABLED: "true", COMBAT_DELTA_HZ: "1" });
      setup.addPlayer("p1", origin);
      const dummyId = spawnDummy(setup);
      const healthBefore = setup.combat.entity(dummyId)!.currentHealth;
      const before = messages(setup.sockets.get("p1")!).length;

      expect(swing(setup, 1)).toMatchObject({ accepted: true });
      setup.runtime.tick(0.05);

      const sent = messages(setup.sockets.get("p1")!).slice(before);
      const result = sent.find((message) => message.type === "SWING_RESULT");
      expect(result).toMatchObject({ requestId: "swing-1", seq: 1, comboIndex: 0 });
      expect(result).not.toHaveProperty("rejected");
      if (result?.type !== "SWING_RESULT") throw new Error("no SWING_RESULT");
      expect(result.hits).toEqual([expect.objectContaining({ entityId: dummyId })]);
      expect(result.hits[0]!.damage).toBeGreaterThan(0);
      expect(result.nextSwingAt).toBeGreaterThan(Date.now() - 1_000);
      expect(setup.combat.entity(dummyId)!.currentHealth).toBeLessThan(healthBefore);
      // Same tick: the immediate flush carried the DAMAGE event without waiting for the next delta slot.
      expect(damageEventsFor(sent, dummyId)).not.toHaveLength(0);
    });

    it("cancels a queued START_ATTACK", () => {
      const setup = createRuntime({ ACTION_COMBAT_ENABLED: "true", DEV_TOOLS_ENABLED: "true" });
      setup.addPlayer("p1", origin);
      const dummyId = spawnDummy(setup, 60);
      setup.runtime.enqueue(command("p1", setup.connectionIds.get("p1")!, "start", {
        kind: "start-attack",
        targetEntityId: dummyId
      }));
      setup.runtime.tick(0);
      expect(setup.combat.entity("p1")?.targetEntityId).toBe(dummyId);

      swing(setup, 1);
      setup.runtime.tick(0);

      expect(swingResults(setup).at(-1)?.hits).toHaveLength(1);
      expect(setup.combat.entity("p1")?.targetEntityId).toBeNull();
    });

    it("delivers a swing pressed mid-dash through onSwingResolved after the landing", () => {
      const setup = createRuntime({ ACTION_COMBAT_ENABLED: "true", DEV_TOOLS_ENABLED: "true" });
      setup.addPlayer("p1", origin);
      setup.runtime.enqueue({
        kind: "dash",
        playerId: "p1",
        accountId: "account-p1",
        connectionId: setup.connectionIds.get("p1")!,
        requestId: "dash-1",
        dirX: 0,
        dirY: 1,
        receivedAtMs: performance.now()
      });
      setup.runtime.tick(0.01);
      expect(setup.gameState.isDashing("p1")).toBe(true);

      swing(setup, 1);
      setup.runtime.tick(0.01);
      expect(swingResults(setup)).toEqual([]);

      for (let index = 0; index < 20 && swingResults(setup).length === 0; index += 1) {
        setup.runtime.tick(0.05);
      }
      expect(setup.gameState.isDashing("p1")).toBe(false);
      expect(swingResults(setup)).toEqual([
        expect.objectContaining({ requestId: "swing-1", seq: 1, hits: [] })
      ]);
      expect(swingResults(setup)[0]).not.toHaveProperty("rejected");
    });

    it("rejects a swing inside an interior", () => {
      const setup = createRuntime({ ACTION_COMBAT_ENABLED: "true" });
      setup.addPlayer("p1", origin);
      setup.runtime.tick(0);
      (setup.combat as unknown as { entities: Map<string, { regionCode: string }> })
        .entities.get("p1")!.regionCode = "interior:manor-1";

      swing(setup, 1);
      setup.runtime.tick(0);

      expect(swingResults(setup)).toEqual([expect.objectContaining({ seq: 1, rejected: "unavailable" })]);
    });

    it("turns SWING spam into one buffered swing and then too_soon, never extra hits", () => {
      const setup = createRuntime({ ACTION_COMBAT_ENABLED: "true", DEV_TOOLS_ENABLED: "true" });
      setup.addPlayer("p1", origin);
      const dummyId = spawnDummy(setup);
      swing(setup, 1);
      setup.runtime.tick(0.05);
      // Recovery after swing 0 is 6 ticks; the buffer opens 3 ticks before it ends.
      for (let index = 0; index < 3; index += 1) setup.runtime.tick(0.05);
      for (let seq = 2; seq <= 8; seq += 1) swing(setup, seq);
      setup.runtime.tick(0.05);

      const results = swingResults(setup);
      expect(results.filter((result) => result.rejected === "too_soon").map((result) => result.seq))
        .toEqual([3, 4, 5, 6, 7, 8]);
      expect(results.some((result) => result.seq === 2)).toBe(false);

      for (let index = 0; index < 10; index += 1) setup.runtime.tick(0.05);
      const settled = swingResults(setup);
      const hitting = settled.filter((result) => result.hits.length > 0);
      expect(hitting.map((result) => result.seq)).toEqual([1, 2]);
      expect(hitting.flatMap((result) => result.hits.map((hit) => hit.entityId))).toEqual([dummyId, dummyId]);
      expect(settled).toHaveLength(8);
    });
  });

  it("replays the immediate bound movement after each of twenty adjacent jumps", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;

    for (let visit = 0; visit < 20; visit += 1) {
      const travelRequestId = `travel-ping-pong-${visit}`;
      const moveRequestId = `move-ping-pong-${visit}`;
      const destinationM = visit % 2 === 0 ? 500 : 800;
      const transition = setup.runtime.beginPlayerWorldTransition(
        "p1",
        travelRequestId
      )!;
      setup.gameState.teleportPlayer("p1", east(destinationM));
      expect(setup.runtime.commitPlayerWorldTransition(
        "p1",
        transition,
        setup.gameState.getPlayer("p1")!.relocationRevision ?? 0
      )).toBe(true);
      expect(setup.runtime.enqueue({
        kind: "move",
        playerId: "p1",
        accountId: "account-p1",
        connectionId,
        requestId: moveRequestId,
        boundTravelRequestId: travelRequestId,
        target: east(destinationM + 20)
      })).toMatchObject({ accepted: true, buffered: true });
      expect(setup.runtime.endPlayerWorldTransition(
        "p1",
        transition,
        "committed"
      )).toBe(true);
      expect(setup.runtime.commands.depth).toBe(1);
      setup.runtime.tick(0);

      expect(setup.gameState.getPlayer("p1")?.target).toEqual(
        east(destinationM + 20)
      );
      expect(messages(setup.sockets.get("p1")!).filter((message) =>
        message.type === "MOVE_ACCEPTED"
        && message.requestId === moveRequestId
      )).toHaveLength(1);
    }
  });

  it("discards request-mismatched, failed, expired, and replaced-connection travel moves", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const envelope = {
      kind: "move" as const,
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      target: east(10)
    };

    let transition = setup.runtime.beginPlayerWorldTransition("p1", "travel-failed")!;
    expect(setup.runtime.enqueue({
      ...envelope,
      requestId: "mismatch",
      boundTravelRequestId: "different-travel"
    })).toEqual({ accepted: false, reason: "transition-pending" });
    expect(setup.runtime.enqueue({
      ...envelope,
      requestId: "failed",
      boundTravelRequestId: "travel-failed"
    })).toMatchObject({ accepted: true, buffered: true });
    setup.runtime.endPlayerWorldTransition("p1", transition, "failed");
    expect(setup.runtime.commands.depth).toBe(1);
    setup.runtime.tick(0);
    expect(setup.gameState.getPlayer("p1")?.target).toEqual(east(10));

    transition = setup.runtime.beginPlayerWorldTransition("p1", "travel-expired")!;
    setup.gameState.teleportPlayer("p1", east(20));
    setup.runtime.commitPlayerWorldTransition(
      "p1",
      transition,
      setup.gameState.getPlayer("p1")!.relocationRevision ?? 0
    );
    expect(setup.runtime.enqueue({
      ...envelope,
      requestId: "expired",
      boundTravelRequestId: "travel-expired"
    })).toMatchObject({ accepted: true, buffered: true });
    now.mockReturnValue(3_001);
    setup.runtime.endPlayerWorldTransition("p1", transition, "committed");
    expect(setup.runtime.commands.depth).toBe(0);
    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ERROR",
        requestId: "expired",
        code: "MOVE_REJECTED"
      })
    ]));

    now.mockReturnValue(4_000);
    transition = setup.runtime.beginPlayerWorldTransition("p1", "travel-replaced")!;
    setup.gameState.teleportPlayer("p1", east(30));
    setup.runtime.commitPlayerWorldTransition(
      "p1",
      transition,
      setup.gameState.getPlayer("p1")!.relocationRevision ?? 0
    );
    expect(setup.runtime.enqueue({
      ...envelope,
      requestId: "replaced",
      boundTravelRequestId: "travel-replaced"
    })).toMatchObject({ accepted: true, buffered: true });
    setup.registry.addWithReplacement({
      accountId: "account-p1",
      playerId: "p1",
      username: "p1",
      regionCode: setup.gameState.getPlayer("p1")!.regionCode,
      zoneId: zoneIdForPosition(origin),
      socket: socket()
    });
    setup.runtime.endPlayerWorldTransition("p1", transition, "committed");
    expect(setup.runtime.commands.depth).toBe(0);
    now.mockRestore();
  });

  it("accepts one matching bound move that races immediately after committed release", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const transition = setup.runtime.beginPlayerWorldTransition("p1", "travel-race")!;
    setup.gameState.teleportPlayer("p1", east(500));
    setup.runtime.commitPlayerWorldTransition(
      "p1",
      transition,
      setup.gameState.getPlayer("p1")!.relocationRevision ?? 0
    );
    setup.runtime.endPlayerWorldTransition("p1", transition, "committed");

    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "racing-move",
      boundTravelRequestId: "travel-race",
      target: east(525)
    })).toMatchObject({ accepted: true });
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "duplicate-racing-move",
      boundTravelRequestId: "travel-race",
      target: east(530)
    })).toEqual({ accepted: false, reason: "transition-pending" });
  });

  it("discards buffered movement from a stale relocation revision", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const transition = setup.runtime.beginPlayerWorldTransition("p1", "travel-stale")!;
    expect(setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "stale-revision-move",
      boundTravelRequestId: "travel-stale",
      target: east(10)
    })).toMatchObject({ accepted: true, buffered: true });

    setup.gameState.teleportPlayer("p1", east(500));
    expect(setup.runtime.endPlayerWorldTransition(
      "p1",
      transition,
      "failed",
      "phase-one-failed"
    )).toBe(true);
    expect(setup.runtime.commands.depth).toBe(0);
    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ERROR",
        requestId: "stale-revision-move",
        code: "MOVE_REJECTED"
      })
    ]));
  });

  it("force-releases stale, replaced, and shutdown transitions idempotently", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(10));
    const p1Connection = setup.connectionIds.get("p1")!;
    const p2Connection = setup.connectionIds.get("p2")!;
    setup.runtime.beginPlayerWorldTransition("p1", "replace-me");
    setup.runtime.beginPlayerWorldTransition("p2", "shutdown-me");

    expect(setup.runtime.forceReleasePlayerWorldTransition(
      "p1",
      p1Connection,
      "connection-replaced"
    )).toBe(true);
    expect(setup.runtime.forceReleasePlayerWorldTransition(
      "p1",
      p1Connection,
      "connection-replaced"
    )).toBe(false);
    expect(setup.runtime.hasPlayerWorldTransition("p1")).toBe(false);
    expect(setup.runtime.forceReleasePlayerWorldTransition(
      "p2",
      `${p2Connection}:stale`,
      "stale-connection"
    )).toBe(false);
    expect(setup.runtime.forceReleaseAllPlayerWorldTransitions("shutdown")).toBe(1);
    expect(setup.runtime.forceReleaseAllPlayerWorldTransitions("shutdown")).toBe(0);
    expect(setup.runtime.hasPlayerWorldTransition("p2")).toBe(false);
  });

  it("processes attack and cancel intents in stable tick order, never in the callback", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(10));
    setup.runtime.enqueue(command("p1", setup.connectionIds.get("p1")!, "start", {
      kind: "start-attack",
      targetEntityId: "p2"
    }));
    setup.runtime.enqueue(command("p1", setup.connectionIds.get("p1")!, "cancel", { kind: "cancel-attack" }));

    expect(setup.combat.entity("p1")?.targetEntityId).toBeNull();
    setup.runtime.tick(0);
    expect(setup.combat.entity("p1")?.targetEntityId).toBeNull();
    expect(setup.combat.entity("p2")?.currentHealth).toBe(100);
    expect(messages(setup.sockets.get("p1")!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "COMBAT_STARTED", requestId: "start" }),
        expect.objectContaining({ type: "COMBAT_CANCELLED", requestId: "cancel" })
      ])
    );
  });

  it("keeps an active combat target and cadence when ordinary movement is accepted", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
      const setup = createRuntime();
      setup.addPlayer("p1", origin);
      const wolf = setup.combat.spawnMob({
        archetype: "wolf",
        position: east(10),
        regionCode: setup.gameState.getPlayer("p1")!.regionCode,
        zoneId: zoneIdForPosition(origin),
        packId: "pack:movement"
      });
      const connectionId = setup.connectionIds.get("p1")!;
      setup.runtime.enqueue(command("p1", connectionId, "attack", {
        kind: "start-attack",
        targetEntityId: wolf.entityId
      }));
      setup.runtime.tick(0.05);
      const nextAttackAt = setup.combat.entity("p1")?.pveCombat?.nextBasicAttackAt;

      setup.runtime.enqueue({
        kind: "move",
        playerId: "p1",
        accountId: "account-p1",
        connectionId,
        requestId: "move-during-combat",
        target: east(100)
      });
      setup.runtime.tick(0.05);

      expect(setup.combat.entity("p1")?.targetEntityId).toBe(wolf.entityId);
      const remainingAttackMs = setup.combat.entity("p1")?.pveCombat?.nextBasicAttackAt;
      expect(remainingAttackMs).toBeLessThan(nextAttackAt!);
      expect(nextAttackAt! - remainingAttackMs!).toBe(50);
      expect(setup.gameState.getPlayer("p1")?.target).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("approaches once on START_ATTACK, then preserves manual movement and resumes on reentry", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const targetMob = setup.combat.spawnMob({
      archetype: "training_dummy",
      position: east(200),
      regionCode: setup.gameState.getPlayer("p1")!.regionCode,
      zoneId: zoneIdForPosition(origin),
      packId: "pack:continuous-movement"
    });
    const initialPlayerPosition = { ...setup.gameState.getPlayer("p1")!.position };
    const initialWolfHealth = targetMob.currentHealth;
    setup.runtime.enqueue(command("p1", setup.connectionIds.get("p1")!, "initial-approach", {
      kind: "start-attack",
      targetEntityId: targetMob.entityId
    }));
    expect(setup.runtime.hasPlayerWorldTransition("p1")).toBe(false);

    let openingAttackTick = 0;
    for (let tick = 1; tick <= 20; tick += 1) {
      setup.runtime.tick(0.05);
      if (
        openingAttackTick === 0 &&
        (setup.combat.entity(targetMob.entityId)?.currentHealth ?? initialWolfHealth) < initialWolfHealth
      ) {
        openingAttackTick = tick;
      }
    }
    const approachedPosition = setup.gameState.getPlayer("p1")!.position;
    const currentWolf = setup.combat.entity(targetMob.entityId)!;
    expect(distanceMeters(approachedPosition, currentWolf))
      .toBeLessThanOrEqual(BASIC_ATTACK_RANGE_M);
    expect(distanceMeters(initialPlayerPosition, approachedPosition)).toBeGreaterThan(0);
    expect(distanceMeters(approachedPosition, targetMob)).toBeLessThanOrEqual(BASIC_ATTACK_RANGE_M);
    expect(setup.gameState.getPlayer("p1")?.target).toBeNull();
    expect(openingAttackTick).toBeGreaterThan(0);

    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "manual-move",
      target: east(350)
    });
    for (let tick = 0; tick < 50; tick += 1) setup.runtime.tick(0.05);
    const movedPlayerPosition = setup.gameState.getPlayer("p1")!.position;
    expect(distanceMeters(movedPlayerPosition, east(350))).toBeLessThanOrEqual(0.1);
    expect(distanceMeters(initialPlayerPosition, movedPlayerPosition)).toBeGreaterThan(300);
    const healthAfterMovingOut = setup.combat.entity(targetMob.entityId)!.currentHealth;
    expect(distanceMeters(
      setup.gameState.getPlayer("p1")!.position,
      setup.combat.entity(targetMob.entityId)!
    )).toBeGreaterThan(BASIC_ATTACK_RANGE_M);
    setup.runtime.tick(0.05);
    expect(setup.combat.entity(targetMob.entityId)!.currentHealth).toBe(healthAfterMovingOut);

    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "manual-return",
      target: east(130)
    });
    for (let tick = 0; tick < 50; tick += 1) setup.runtime.tick(0.05);
    expect(distanceMeters(setup.gameState.getPlayer("p1")!.position, east(130)))
      .toBeLessThanOrEqual(0.1);
    expect(setup.combat.entity("p1")?.targetEntityId).toBe(targetMob.entityId);
    expect(setup.combat.entity(targetMob.entityId)!.currentHealth).toBeLessThan(healthAfterMovingOut);

    expect(setup.combat.cancelCombat("p1")).toBe(true);
    const healthAfterCancel = setup.combat.entity(targetMob.entityId)!.currentHealth;
    for (let tick = 0; tick < 40; tick += 1) setup.runtime.tick(0.05);
    expect(setup.combat.entity(targetMob.entityId)!.currentHealth).toBe(healthAfterCancel);
  });

  it("routes developer Deer and Ogre spawning through the shared authoritative combat entity path", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    for (const [archetype, distanceM] of [["deer", 10], ["ogre", 20]] as const) {
      setup.runtime.enqueue({
        kind: "dev-spawn-mob",
        playerId: "p1",
        accountId: "account-p1",
        connectionId,
        requestId: `spawn-${archetype}`,
        archetype,
        position: east(distanceM)
      });
    }
    setup.runtime.tick(0.05);

    const spawned = messages(setup.sockets.get("p1")!).filter(
      (message) => message.type === "DEV_MOB_SPAWNED"
    );
    expect(spawned.map((message) => message.archetype)).toEqual(["deer", "ogre"]);
    for (const message of spawned) {
      if (message.type !== "DEV_MOB_SPAWNED") continue;
      expect(setup.combat.entity(message.mobEntityId)).toMatchObject({
        kind: "mob",
        archetypeKey: message.archetype,
        lifeState: "alive"
      });
    }
  });

  it("serializes Knight Taunt through the world command queue without client targets", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.combat.updatePlayerClassState("p1", {
      playerId: "p1", characterLevel: 25, activeClassId: "knight", activeSubclassId: null,
      warrior: { classId: "warrior", level: 0, xp: 0, nextLevelXp: 1193, completedAt: null },
      knight: { classId: "knight", level: 3, xp: 4257, nextLevelXp: 6212, completedAt: null },
      subclasses: [], legacyIds: [],
      loadout: { resetActives: [null, null], normalActives: ["knight_taunt", null],
        passiveTiers: [null, null, null], ultimateActive: null },
      rage: 0, maximumRage: 0, queuedAbility: null, cooldownEndsAt: {}, serverTime: 0, revision: 1
    }, { playerId: "p1", instances: [], weapon: null, chest: null,
      totalAttackPowerBonus: 0, totalDefenseBonus: 0 });
    const mob = setup.combat.spawnMob({
      archetype: "goblin",
      position: east(10),
      regionCode: setup.gameState.getPlayer("p1")!.regionCode,
      zoneId: zoneIdForPosition(origin)
    });
    setup.runtime.enqueue({
      kind: "universal-taunt",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "taunt"
    });

    expect(setup.combat.entity("p1")?.pveCombat).toBeNull();
    setup.runtime.tick(0);
    expect(setup.combat.entity("p1")?.pveCombat?.enemyQueue).toEqual([mob.entityId]);
    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ABILITY_QUEUE_UPDATED",
        requestId: "taunt",
        pveCombat: expect.objectContaining({ enemyQueue: [mob.entityId] })
      })
    ]));
  });

  it("replicates only nearby players at 20 Hz and includes the local player", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(20));
    setup.addPlayer("far", east(2_000));
    for (const playerId of ["p1", "p2", "far"]) {
      setup.runtime.replication.resetPlayer(playerId);
    }

    setup.runtime.tick(0);

    const snapshot = messages(setup.sockets.get("p1")!).find(
      (message) => message.type === "PLAYER_SNAPSHOT"
    );
    expect(snapshot).toMatchObject({ type: "PLAYER_SNAPSHOT", sequence: 0 });
    if (snapshot?.type !== "PLAYER_SNAPSHOT") {
      throw new Error("expected player snapshot");
    }
    expect(snapshot.players.map((player) => player.playerId)).toEqual(["p1", "p2"]);
    expect(setup.combat.metricsSnapshot().aoiCacheHits).toBeGreaterThan(0);
  });

  it("withholds player replication from a transitioning recipient without consuming its baseline", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const socket = setup.sockets.get("p1")!;
    setup.runtime.replication.resetPlayer("p1");
    setup.runtime.tick(0);
    expect(messages(socket)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "PLAYER_SNAPSHOT", sequence: 0 })
    ]));
    const replicationMetricsBeforeTransition =
      setup.runtime.replication.metricsSnapshot();
    socket.send.mockClear();

    const transition = setup.runtime.beginPlayerWorldTransition(
      "p1",
      "flag-arrival-frame-gate"
    );
    expect(transition).not.toBeNull();
    expect(setup.runtime.withholdsPlayerReplication("p1")).toBe(true);
    const destination = east(500);
    setup.gameState.teleportPlayer("p1", destination);

    setup.runtime.tick(0);

    expect(messages(socket).some(
      (message) =>
        message.type === "PLAYER_SNAPSHOT" || message.type === "PLAYER_DELTA"
    )).toBe(false);
    expect(setup.runtime.replication.needsSnapshot("p1")).toBe(false);
    expect(setup.runtime.replication.metricsSnapshot())
      .toEqual(replicationMetricsBeforeTransition);

    expect(setup.runtime.endPlayerWorldTransition("p1", transition!)).toBe(true);
    setup.runtime.tick(0);

    const delta = messages(socket).find(
      (message) => message.type === "PLAYER_DELTA"
    );
    expect(delta).toMatchObject({
      type: "PLAYER_DELTA",
      sequence: 1,
      upserts: [
        expect.objectContaining({
          kind: "full",
          player: expect.objectContaining({
            playerId: "p1",
            lat: destination.lat,
            lon: destination.lon
          })
        })
      ]
    });
  });

  it("keeps movement replication live for an explicitly live world transition", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const socket = setup.sockets.get("p1")!;
    setup.runtime.replication.resetPlayer("p1");
    setup.runtime.tick(0);
    socket.send.mockClear();

    const transition = setup.runtime.beginPlayerWorldTransition(
      "p1",
      "portal-approach",
      { withholdPlayerReplication: false }
    );
    expect(transition).not.toBeNull();
    expect(setup.runtime.withholdsPlayerReplication("p1")).toBe(false);
    const target = east(100);
    setup.gameState.setTarget("p1", target);

    setup.runtime.tick(0);

    expect(messages(socket)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "PLAYER_DELTA",
        sequence: 1,
        upserts: [
          expect.objectContaining({
            kind: "movement",
            playerId: "p1",
            targetLat: target.lat,
            targetLon: target.lon,
            moving: true
          })
        ]
      })
    ]));
    expect(setup.runtime.endPlayerWorldTransition("p1", transition!)).toBe(true);
  });

  it("queries authoritative visible player IDs without mutating replication state", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.addPlayer("near", east(20));
    setup.addPlayer("far", east(2_000));
    setup.runtime.replication.resetPlayer("p1");
    const metricsBefore = setup.runtime.replication.metricsSnapshot();

    expect(setup.runtime.visiblePlayerIdsFor("p1")).toEqual(["near", "p1"]);
    expect(setup.runtime.replication.needsSnapshot("p1")).toBe(true);
    expect(setup.runtime.replication.metricsSnapshot()).toEqual(metricsBefore);
  });

  it("does not widen anchor interest for an out-of-circle player at the same flag", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(2_000));
    const vision = resourceVisionForFlag({
      flagId: "shared-flag",
      flagName: "Shared Flag",
      flagCenter: origin,
      movementLeashRadiusM: setup.gameState.getPlayer("p1")!.moveLeashRadiusM
    });
    setup.gameState.applyValidatedFlagVisit("p1", vision, origin);
    setup.gameState.applyValidatedFlagVisit("p2", vision, east(2_000));

    expect([...setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1")!].sort())
      .toEqual(["p1"]);
    expect(setup.runtime.visiblePlayerIdsFor("p1")).toEqual(["p1"]);
    expect(setup.runtime.positionVisiblePlayerIdsFor("p1")).toEqual(["p1"]);

    setup.runtime.replication.resetPlayer("p1");
    setup.runtime.tick(0);
    const snapshot = messages(setup.sockets.get("p1")!).find(
      (message) => message.type === "PLAYER_SNAPSHOT"
    );
    expect(snapshot).toMatchObject({
      type: "PLAYER_SNAPSHOT",
      players: [
        expect.objectContaining({ playerId: "p1" })
      ]
    });
    if (snapshot?.type === "PLAYER_SNAPSHOT") {
      expect(snapshot.players.map((player) => player.playerId)).toEqual(["p1"]);
    }
  });

  it("emits one mutual position-visibility entry per continuous encounter", () => {
    const setup = createRuntime();
    const onEntries = vi.fn();
    setup.runtime.setMutualPositionVisibilityEntryHandler(onEntries);
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(20));

    setup.runtime.tick(0);
    setup.runtime.tick(0);
    expect(onEntries).toHaveBeenCalledTimes(1);
    expect(onEntries).toHaveBeenCalledWith([["p1", "p2"]]);

    setup.gameState.teleportPlayer("p2", east(2_000));
    setup.runtime.tick(0);
    setup.gameState.teleportPlayer("p2", east(20));
    setup.runtime.tick(0);
    expect(onEntries).toHaveBeenCalledTimes(2);
  });

  it("uses exact gameplay-view distance and excludes active transitions from social visibility", () => {
    const setup = createRuntime({ COMBAT_INTEREST_RADIUS_M: "100" });
    setup.addPlayer("p1", origin);
    const radius = setup.gameState.getGameplayViewCircle("p1")!.radiusM;
    setup.addPlayer("edge", east(radius - 0.01));
    setup.addPlayer("outside", east(radius + 1));
    expect(setup.runtime.positionVisiblePlayerIdsFor("p1")).toEqual(["edge", "p1"]);

    const onEntries = vi.fn();
    setup.runtime.setMutualPositionVisibilityEntryHandler(onEntries);
    const token = setup.runtime.beginPlayerWorldTransition("edge")!;
    setup.runtime.tick(0);
    expect(onEntries).not.toHaveBeenCalled();
    setup.runtime.endPlayerWorldTransition("edge", token);
    setup.runtime.tick(0);
    expect(onEntries).toHaveBeenCalledTimes(1);
    const enteredPairs = onEntries.mock.calls[0]![0];
    expect(enteredPairs).toContainEqual(["edge", "p1"]);
    expect(enteredPairs).not.toContainEqual(["outside", "p1"]);
  });

  it.each([
    ["offline", (setup: ReturnType<typeof createRuntime>) => setup.gameState.markOffline("p2")],
    ["outside the public world", (setup: ReturnType<typeof createRuntime>) =>
      setup.gameState.setWorldPresence("p2", false)]
  ])("excludes a nearby player who is %s from the visible ID query", (_case, exclude) => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.addPlayer("p2", east(20));
    exclude(setup);

    expect(setup.runtime.visiblePlayerIdsFor("p1")).toEqual(["p1"]);
  });

  it("continues combat replication for a player inside an instanced space", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.gameState.setWorldPresence("p1", false);
    setup.runtime.replication.resetPlayer("p1");
    setup.combat.requestResync("p1");

    for (let tick = 0; tick < 4; tick += 1) setup.runtime.tick(0);

    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMBAT_SNAPSHOT" })
    ]));
    expect(messages(setup.sockets.get("p1")!).some(
      (message) => message.type === "PLAYER_SNAPSHOT" || message.type === "PLAYER_DELTA"
    )).toBe(false);
  });

  it("coalesces replaceable state for a slow client while healthy clients continue", () => {
    const setup = createRuntime();
    setup.addPlayer("slow", origin, 600_000);
    setup.addPlayer("healthy", east(10));
    setup.runtime.replication.resetPlayer("slow");
    setup.runtime.replication.resetPlayer("healthy");

    setup.runtime.tick(0);
    expect(setup.sockets.get("slow")!.send).not.toHaveBeenCalled();
    expect(setup.sockets.get("healthy")!.send).toHaveBeenCalled();

    setup.sockets.get("slow")!.bufferedAmount = 0;
    setup.runtime.tick(0);
    expect(
      messages(setup.sockets.get("slow")!).some((message) => message.type === "PLAYER_SNAPSHOT")
    ).toBe(true);
    expect(setup.registry.metricsSnapshot().replaceableCoalesced).toBeGreaterThan(0);
  });

  it("recovers a skipped moving delta with snapshot zero followed by delta one", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const setup = createRuntime();
      setup.addPlayer("p1", origin);
      setup.runtime.replication.resetPlayer("p1");
      setup.runtime.tick(0);
      const playerSocket = setup.sockets.get("p1")!;
      playerSocket.send.mockClear();

      vi.advanceTimersByTime(1_000);
      setup.gameState.setTarget("p1", east(400));
      playerSocket.bufferedAmount = 600_000;
      setup.runtime.tick(0.01);
      expect(setup.registry.metricsSnapshot().replaceableSkipped).toBeGreaterThan(0);

      playerSocket.bufferedAmount = 0;
      setup.runtime.tick(0.01);
      vi.advanceTimersByTime(1_000);
      setup.gameState.setTarget("p1", east(500));
      setup.runtime.tick(0.01);

      const replicationMessages = messages(playerSocket).filter(
        (message) => message.type === "PLAYER_SNAPSHOT" || message.type === "PLAYER_DELTA"
      );
      expect(replicationMessages).toEqual([
        expect.objectContaining({ type: "PLAYER_SNAPSHOT", sequence: 0 }),
        expect.objectContaining({ type: "PLAYER_DELTA", sequence: 1 })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges rapid movement commands in order and preserves the newest destination", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const firstTarget = east(100);
    const newestTarget = east(200);
    const connectionId = setup.connectionIds.get("p1")!;
    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-1",
      target: firstTarget
    });
    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-2",
      target: newestTarget
    });

    setup.runtime.tick(0);

    const acknowledgements = messages(setup.sockets.get("p1")!)
      .filter((message) => message.type === "MOVE_ACCEPTED");
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId: "move-1", movementRevision: 2, target: firstTarget }),
      expect.objectContaining({ requestId: "move-2", movementRevision: 3, target: newestTarget })
    ]);
    expect(setup.gameState.snapshotForPlayer("p1")).toMatchObject({
      movementRevision: 3,
      targetLat: newestTarget.lat,
      targetLon: newestTarget.lon
    });
  });

  it("uses visit lifecycle commands as barriers without cancelling a later move", () => {
    const setup = createRuntime();
    setup.addPlayer("before-visit", origin);
    setup.addPlayer("after-visit", east(10));
    const oldTarget = east(100);
    const newTarget = east(200);

    for (const playerId of ["before-visit", "after-visit"]) {
      const connectionId = setup.connectionIds.get(playerId)!;
      setup.runtime.enqueue({
        kind: "move",
        playerId,
        accountId: `account-${playerId}`,
        connectionId,
        requestId: `${playerId}:old-move`,
        target: oldTarget
      });
      setup.runtime.enqueue({
        kind: "lifecycle-cancel",
        playerId,
        accountId: `account-${playerId}`,
        connectionId,
        requestId: `${playerId}:visit`,
        reason: "visit-flag"
      });
    }
    setup.runtime.enqueue({
      kind: "move",
      playerId: "after-visit",
      accountId: "account-after-visit",
      connectionId: setup.connectionIds.get("after-visit")!,
      requestId: "after-visit:new-move",
      target: newTarget
    });

    setup.runtime.tick(0);

    expect(setup.gameState.getPlayer("before-visit")?.target).toBeNull();
    expect(setup.gameState.getPlayer("after-visit")?.target).toEqual(newTarget);
  });

  it("resolves tracked lifecycle commands only after the world tick processes them", async () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.gameState.setTarget("p1", east(100));
    const result = setup.runtime.enqueueTracked({
      kind: "lifecycle-cancel",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "visit:p1",
      reason: "visit-flag"
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      throw new Error("tracked lifecycle command was not accepted");
    }
    expect(setup.gameState.getPlayer("p1")?.target).not.toBeNull();

    setup.runtime.tick(0);

    await expect(result.completion).resolves.toBe("processed");
    expect(setup.gameState.getPlayer("p1")?.target).toBeNull();
  });

  it("applies a queued dev teleport before a movement command issued after it", async () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    const destination = east(300);
    const laterTarget = east(350);
    const teleport = setup.runtime.enqueueTracked({
      kind: "dev-teleport",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "dev-teleport:p1",
      destination
    });
    expect(teleport.accepted).toBe(true);
    if (!teleport.accepted) {
      throw new Error("tracked dev teleport was not accepted");
    }
    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "move-after-dev-teleport",
      target: laterTarget
    });

    setup.runtime.tick(0);

    await expect(teleport.completion).resolves.toBe("processed");
    expect(setup.gameState.getPlayer("p1")).toMatchObject({
      position: destination,
      anchor: destination,
      target: laterTarget
    });
  });

  it("rejects a queued movement command after an intervening relocation", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const connectionId = setup.connectionIds.get("p1")!;
    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId,
      requestId: "stale-before-teleport",
      target: east(100)
    });
    const destination = east(500);
    setup.gameState.teleportPlayer("p1", destination);

    setup.runtime.tick(0);

    expect(setup.gameState.getPlayer("p1")).toMatchObject({
      position: destination,
      target: null
    });
    expect(messages(setup.sockets.get("p1")!)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ERROR",
        requestId: "stale-before-teleport",
        code: "MOVE_EPOCH_STALE"
      })
    ]));
  });

  it("can send a pending full snapshot after accepting a movement command", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    setup.runtime.replication.resetPlayer("p1");
    const target = east(400);
    setup.runtime.enqueue({
      kind: "move",
      playerId: "p1",
      accountId: "account-p1",
      connectionId: setup.connectionIds.get("p1")!,
      requestId: "move-before-resync",
      target
    });

    setup.runtime.tick(0.02);

    const sent = messages(setup.sockets.get("p1")!);
    const acceptedIndex = sent.findIndex((message) => message.type === "MOVE_ACCEPTED");
    const snapshotIndex = sent.findIndex((message) => message.type === "PLAYER_SNAPSHOT");
    expect(acceptedIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(acceptedIndex);
    expect(sent[snapshotIndex]).toMatchObject({
      type: "PLAYER_SNAPSHOT",
      players: [expect.objectContaining({ movementRevision: 2 })]
    });
  });

  it("withholds combat by exact population authority and rejects replaced connections", () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const player = setup.gameState.getPlayer("p1")!;
    const view = setup.gameState.getGameplayViewCircle("p1")!;
    const connectionId = setup.connectionIds.get("p1")!;
    const mob = setup.combat.spawnMob({
      entityId: "mob:withheld-population",
      archetype: "wolf",
      worldAi: true,
      position: origin,
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(origin),
      populationAuthority: {
        ownerToken: "00000000-0000-4000-8000-000000000553",
        fencingGeneration: 1,
        cutoverRevision: 1
      }
    });
    const authority = {
      playerId: "p1",
      connectionId,
      connectionGeneration: 4,
      preparationGeneration: 9,
      relocationRevision: player.relocationRevision ?? 0,
      resourceVisionRevision: setup.gameState.getResourceVisionRevision("p1"),
      gameplayViewGeneration: view.generation
    };
    const zoneId = populationZoneV2IdForPoint(origin);

    expect(setup.runtime.updateWithheldPopulationZones({
      ...authority,
      withheldZoneIds: [zoneId]
    })).toBe(true);
    expect(setup.runtime.markMobAiPresentationAuthority({
      playerId: authority.playerId,
      connectionId: authority.connectionId,
      connectionGeneration: authority.connectionGeneration,
      relocationRevision: authority.relocationRevision,
      resourceVisionRevision: authority.resourceVisionRevision,
      gameplayViewGeneration: authority.gameplayViewGeneration,
      populationPreparationGeneration: authority.preparationGeneration
    }, [mob.entityId])).toBe(true);
    setup.runtime.tick(0);
    expect(setup.combat.entity(mob.entityId)?.targetEntityId).toBeNull();
    expect(setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1"))
      .not.toContain(mob.entityId);
    setup.runtime.enqueue(command(
      "p1",
      connectionId,
      "withheld-attack",
      { kind: "start-attack", targetEntityId: mob.entityId }
    ));
    setup.runtime.tick(0);
    expect(messages(setup.sockets.get("p1")!)).toContainEqual(
      expect.objectContaining({
        type: "ERROR",
        requestId: "withheld-attack",
        code: "COMBAT_TARGET_NO_LONGER_AVAILABLE",
        details: expect.objectContaining({
          combatValidationPredicate: "population-zone-withheld"
        })
      })
    );

    const xoral = setup.combat.spawnMob({
      entityId: "xoral:active-withheld-zone",
      archetype: "xoral",
      worldAi: false,
      bossEventState: "active",
      position: origin,
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(origin)
    });
    expect(setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1"))
      .toContain(xoral.entityId);
    setup.runtime.enqueue(command(
      "p1",
      connectionId,
      "xoral-attack-in-withheld-zone",
      { kind: "start-attack", targetEntityId: xoral.entityId }
    ));
    setup.runtime.tick(0);
    expect(messages(setup.sockets.get("p1")!)).toContainEqual(
      expect.objectContaining({
        type: "COMBAT_STARTED",
        requestId: "xoral-attack-in-withheld-zone",
        targetEntityId: xoral.entityId
      })
    );
    expect(setup.combat.entity("p1")?.pveCombat?.focusTargetEntityId)
      .toBe(xoral.entityId);

    expect(setup.runtime.updateWithheldPopulationZones({
      ...authority,
      connectionGeneration: authority.connectionGeneration - 1,
      withheldZoneIds: []
    })).toBe(false);
    expect(setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1"))
      .not.toContain(mob.entityId);

    setup.registry.remove(connectionId);
    expect(setup.runtime.updateWithheldPopulationZones({
      ...authority,
      preparationGeneration: authority.preparationGeneration + 1,
      withheldZoneIds: []
    })).toBe(false);

    const replacement = setup.registry.add({
      accountId: "account-p1",
      playerId: "p1",
      username: "p1",
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(origin),
      socket: socket()
    });
    setup.combat.rotatePlayerAuthority("p1", "account-p1", replacement);
    expect(setup.runtime.updateWithheldPopulationZones({
      ...authority,
      connectionId: replacement,
      connectionGeneration: authority.connectionGeneration + 1,
      preparationGeneration: authority.preparationGeneration + 1,
      withheldZoneIds: []
    })).toBe(true);
    expect(setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1"))
      .toContain(mob.entityId);
    setup.runtime.tick(0);
    expect(setup.combat.entity(mob.entityId)?.targetEntityId).toBeNull();
    expect(setup.runtime.markMobAiPresentationAuthority({
      playerId: authority.playerId,
      connectionId: replacement,
      connectionGeneration: authority.connectionGeneration + 1,
      relocationRevision: authority.relocationRevision,
      resourceVisionRevision: authority.resourceVisionRevision,
      gameplayViewGeneration: authority.gameplayViewGeneration,
      populationPreparationGeneration: authority.preparationGeneration + 1
    }, [mob.entityId])).toBe(true);
    setup.runtime.tick(0);
    expect(setup.combat.entity(mob.entityId)?.targetEntityId).toBeNull();
    for (let tick = 0; tick < 60; tick += 1) {
      now += 50;
      setup.runtime.tick(0.05);
    }
    expect(setup.combat.entity(mob.entityId)?.targetEntityId).toBe("p1");
  });

  it("keeps an already presented population mob visible through transient withholding", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const player = setup.gameState.getPlayer("p1")!;
    const view = setup.gameState.getGameplayViewCircle("p1")!;
    const connectionId = setup.connectionIds.get("p1")!;
    const mob = setup.combat.spawnMob({
      entityId: "mob:presented-before-withholding",
      archetype: "deer",
      worldAi: true,
      position: origin,
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(origin),
      populationAuthority: {
        ownerToken: "00000000-0000-4000-8000-000000000554",
        fencingGeneration: 1,
        cutoverRevision: 1
      }
    });
    const authority = {
      playerId: "p1",
      connectionId,
      connectionGeneration: 4,
      preparationGeneration: 9,
      relocationRevision: player.relocationRevision ?? 0,
      resourceVisionRevision: setup.gameState.getResourceVisionRevision("p1"),
      gameplayViewGeneration: view.generation
    };

    expect(setup.runtime.updateWithheldPopulationZones({
      ...authority,
      withheldZoneIds: []
    })).toBe(true);
    expect(setup.runtime.markMobAiPresentationAuthority({
      playerId: authority.playerId,
      connectionId: authority.connectionId,
      connectionGeneration: authority.connectionGeneration,
      relocationRevision: authority.relocationRevision,
      resourceVisionRevision: authority.resourceVisionRevision,
      gameplayViewGeneration: authority.gameplayViewGeneration,
      populationPreparationGeneration: authority.preparationGeneration
    }, [mob.entityId])).toBe(true);

    expect(setup.runtime.updateWithheldPopulationZones({
      ...authority,
      withheldZoneIds: [populationZoneV2IdForPoint(origin)]
    })).toBe(true);
    expect(setup.runtime.interestFrameFor(["p1"]).nearbyIdsByPlayer.get("p1"))
      .toContain(mob.entityId);

    setup.runtime.enqueue(command(
      "p1",
      connectionId,
      "retained-mob-attack",
      { kind: "start-attack", targetEntityId: mob.entityId }
    ));
    setup.runtime.tick(0);
    expect(messages(setup.sockets.get("p1")!)).toContainEqual(
      expect.objectContaining({
        type: "COMBAT_STARTED",
        requestId: "retained-mob-attack",
        targetEntityId: mob.entityId
      })
    );
  });

  it("arms proactive mob AI only after matching presentation and fences transitions", () => {
    const setup = createRuntime();
    setup.addPlayer("p1", origin);
    const player = setup.gameState.getPlayer("p1")!;
    const view = setup.gameState.getGameplayViewCircle("p1")!;
    const connectionId = setup.connectionIds.get("p1")!;
    const wolf = setup.combat.spawnMob({
      entityId: "mob:presentation-gated-wolf",
      archetype: "wolf",
      worldAi: true,
      packId: "pack:presentation-gated",
      position: origin,
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(origin)
    });
    const unpublishedWolf = setup.combat.spawnMob({
      entityId: "mob:not-yet-presented-wolf",
      archetype: "wolf",
      worldAi: true,
      packId: "pack:not-yet-presented",
      position: origin,
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition(origin)
    });
    const authority = {
      playerId: "p1",
      connectionId,
      connectionGeneration: 1,
      relocationRevision: player.relocationRevision ?? 0,
      resourceVisionRevision: setup.gameState.getResourceVisionRevision("p1"),
      gameplayViewGeneration: view.generation,
      populationPreparationGeneration: 0
    };

    setup.runtime.tick(0);
    expect(setup.combat.entity(wolf.entityId)?.targetEntityId).toBeNull();
    expect(setup.runtime.markMobAiPresentationAuthority(authority, [wolf.entityId])).toBe(true);
    setup.runtime.tick(0);
    expect(setup.combat.entity(wolf.entityId)?.aiPresentation?.phase).toBe("acquiring");
    for (let tick = 0; tick < 60; tick += 1) setup.runtime.tick(0);
    expect(setup.combat.entity(wolf.entityId)?.targetEntityId).toBe("p1");
    expect(setup.combat.entity(unpublishedWolf.entityId)?.targetEntityId).toBeNull();

    setup.combat.cancelCombat("p1");
    const transition = setup.runtime.beginPlayerWorldTransition("p1", "flag-jump");
    expect(transition).not.toBeNull();
    expect(setup.combat.entity(wolf.entityId)?.targetEntityId).toBeNull();
    const destination = east(100);
    const relocated = setup.gameState.teleportPlayer("p1", destination);
    setup.combat.syncPlayer({
      playerId: "p1",
      position: relocated.position,
      regionCode: relocated.regionCode,
      zoneId: zoneIdForPosition(relocated.position)
    });
    expect(setup.runtime.commitPlayerWorldTransition(
      "p1",
      transition!,
      relocated.relocationRevision ?? 0
    )).toBe(true);
    const relocatedView = setup.gameState.getGameplayViewCircle("p1")!;
    const relocatedAuthority = {
      ...authority,
      relocationRevision: relocated.relocationRevision ?? 0,
      resourceVisionRevision: setup.gameState.getResourceVisionRevision("p1"),
      gameplayViewGeneration: relocatedView.generation
    };
    expect(setup.runtime.markMobAiPresentationAuthority(
      relocatedAuthority,
      [wolf.entityId]
    )).toBe(true);
    setup.runtime.tick(0);
    expect(setup.combat.entity(wolf.entityId)?.targetEntityId).toBeNull();
    expect(setup.runtime.endPlayerWorldTransition("p1", transition!)).toBe(true);
    setup.runtime.tick(0);
    expect(setup.combat.entity(wolf.entityId)?.aiPresentation?.phase).toBe("acquiring");
    for (let tick = 0; tick < 60; tick += 1) setup.runtime.tick(0);
    expect(setup.combat.entity(wolf.entityId)?.targetEntityId).toBe("p1");
    expect(setup.combat.entity(unpublishedWolf.entityId)?.targetEntityId).toBeNull();
  });
});

function createRuntime(
  configOverrides: NodeJS.ProcessEnv = {},
  manorRuntime?: { get(playerId: string): { sessionId: string } | null; disconnect(playerId: string, sessionId: string): void }
) {
  const config = loadConfig({ NODE_ENV: "test", ...configOverrides });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  let runtimeRef: WorldRuntime | null = null;
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    interestRadiusM: config.COMBAT_INTEREST_RADIUS_M,
    playerMovementSpeedMps: config.PLAYER_SPEED_MPS,
    getAuthoritativeViewCircle: (playerId) => gameState.getGameplayViewCircle(playerId),
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    canMobProactivelyAcquire: (mobEntityId, playerId) =>
      runtimeRef?.canMobProactivelyAcquire(mobEntityId, playerId) ?? false,
    canMobContinueIntent: (mobEntityId, playerId) =>
      runtimeRef?.canMobContinueIntent(mobEntityId, playerId) ?? false,
    random: () => 1,
    movePlayerToward: (playerId, target) => gameState.setCombatTarget(playerId, target),
    stopPlayer: (playerId) => gameState.stopPlayer(playerId),
    actionCombatEnabled: () => config.ACTION_COMBAT_ENABLED,
    isEntityDashing: (entityId) => gameState.isDashing(entityId),
    onSwingResolved: (playerId, result) => runtimeRef?.deliverBufferedSwingResult(playerId, result)
  });
  const runtime = new WorldRuntime(
    config,
    registry,
    gameState,
    combat,
    logger,
    manorRuntime as never
  );
  runtimeRef = runtime;
  const sockets = new Map<string, ReturnType<typeof socket>>();
  const connectionIds = new Map<string, string>();
  return {
    registry,
    gameState,
    combat,
    runtime,
    sockets,
    connectionIds,
    addPlayer(playerId: string, position: typeof origin, bufferedAmount = 0) {
      gameState.helloPlayer(playerId, playerId);
      gameState.teleportPlayer(playerId, position);
      const regionCode = gameState.getPlayer(playerId)!.regionCode;
      const zoneId = zoneIdForPosition(position);
      const value = socket(bufferedAmount);
      sockets.set(playerId, value);
      const connectionId = registry.add({
        accountId: `account-${playerId}`,
        playerId,
        username: playerId,
        regionCode,
        zoneId,
        socket: value
      });
      connectionIds.set(playerId, connectionId);
      combat.connectPlayer({
        playerId,
        name: playerId,
        regionCode,
        zoneId,
        position,
        accountId: `account-${playerId}`,
        connectionId,
        profile: {
          playerId,
          maxHealth: 100,
          currentHealth: 100,
          baseAttackDamage: 10,
          persistenceVersion: 0
        }
      });
    }
  };
}

function command<K extends "start-attack" | "cancel-attack">(
  playerId: string,
  connectionId: string,
  requestId: string,
  details: K extends "start-attack"
    ? { kind: K; targetEntityId: string }
    : { kind: K }
) {
  return {
    ...details,
    playerId,
    accountId: `account-${playerId}`,
    connectionId,
    requestId
  } as never;
}

function socket(bufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount,
    send: vi.fn(),
    close: vi.fn()
  } satisfies SocketLike;
}

function messages(value: ReturnType<typeof socket>): ServerMessage[] {
  return value.send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as ServerMessage);
}

function setCombatHealth(
  combat: CombatEngine,
  entityId: string,
  currentHealth: number
): void {
  const state = combat as unknown as {
    entities: Map<string, { currentHealth: number }>;
  };
  state.entities.get(entityId)!.currentHealth = currentHealth;
}

function east(distanceM: number) {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}
