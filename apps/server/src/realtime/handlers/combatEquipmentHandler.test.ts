import type { ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { GameState } from "../../game/state.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { XoralEventService } from "../../game/xoralEvents.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import {
  createCombatEquipmentHandler,
  type CombatEquipmentHandlerContext
} from "./combatEquipmentHandler.js";

const startResult = {
  eventId: "event-1",
  entityId: "xoral:event-1",
  leaderPlayerId: "leader",
  participantIds: ["leader", "member"],
  partyId: "party-1",
  partyRevision: 4,
  anchor: { lat: 35.0844, lon: -106.6504 },
  regionCode: "US-NM",
  zoneId: "combat-zone-1"
};

describe("Xoral event start handler", () => {
  it("keeps the Xoral retryable when one participant cannot finish travel", async () => {
    const resetStartingEvent = vi.fn(async () => true);
    const activateStartedEvent = vi.fn();
    const sent: Array<{ playerId: string; message: ServerMessage }> = [];
    const recenterXoralParticipant = vi.fn(async (playerId: string) =>
      playerId === "member"
        ? {
            success: false as const,
            reason: {
              code: "PLAYER_WORLD_TRANSITION_PENDING",
              message: "Another travel transition is already pending."
            }
          }
        : { success: true as const }
    );
    const handler = handlerFor({
      resetStartingEvent,
      activateStartedEvent,
      recenterXoralParticipant,
      sent
    });

    await handler({
      type: "START_XORAL_EVENT",
      requestId: "start-1",
      xoralEntityId: startResult.entityId
    });

    expect(resetStartingEvent).toHaveBeenCalledWith(
      startResult.eventId,
      startResult.participantIds
    );
    expect(activateStartedEvent).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    expect(sent.map(({ message }) => message)).toEqual([
      expect.objectContaining({
        type: "ERROR",
        code: "PLAYER_WORLD_TRANSITION_PENDING",
        retryable: true,
        message: expect.stringContaining("The Xoral remains available")
      }),
      expect.objectContaining({
        type: "ERROR",
        code: "PLAYER_WORLD_TRANSITION_PENDING",
        retryable: true
      })
    ]);
    expect(sent.some(({ message }) => message.type === "XORAL_EVENT_CANCELLED")).toBe(false);
  });

  it("activates only after every captured participant recenters", async () => {
    const activateStartedEvent = vi.fn(async () => undefined);
    const sent: Array<{ playerId: string; message: ServerMessage }> = [];
    const recenterXoralParticipant = vi.fn(async () => ({ success: true as const }));
    const handler = handlerFor({
      resetStartingEvent: vi.fn(async () => true),
      activateStartedEvent,
      recenterXoralParticipant,
      sent
    });

    await handler({
      type: "START_XORAL_EVENT",
      requestId: "start-2",
      xoralEntityId: startResult.entityId
    });

    expect(recenterXoralParticipant).toHaveBeenCalledTimes(2);
    expect(recenterXoralParticipant.mock.invocationCallOrder.at(-1))
      .toBeLessThan(activateStartedEvent.mock.invocationCallOrder[0]!);
    expect(sent.map(({ message }) => message.type)).toEqual([
      "XORAL_EVENT_STARTED",
      "XORAL_EVENT_STARTED"
    ]);
  });
});

describe("RESPAWN_PLAYER handler", () => {
  it("completes recovery through the same player authority fence without nesting it", async () => {
    const fence = new PlayerAuthorityFence();
    const order: string[] = [];
    const settle = vi.fn(async (_playerId, complete) => complete("player-death:fenced"));
    const { handler, errors, recover, respawn } = respawnHandlerFor(
      settle, order, undefined, undefined, fence
    );
    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-fenced" });
    expect(recover).toHaveBeenCalledWith("leader", "player-death:fenced");
    expect(respawn).toHaveBeenCalledWith("leader");
    expect(order).toEqual(["recovery", "respawn"]);
    expect(errors).toEqual([]);
  });

  it("awaits the application settlement hook", async () => {
    const order: string[] = [];
    const settleAndRespawnPlayer = vi.fn(async (_playerId, complete) => {
      order.push("penalty");
      return complete("player-death:one");
    });
    const { handler, errors, recover, respawn } = respawnHandlerFor(settleAndRespawnPlayer, order);
    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-1" });
    expect(settleAndRespawnPlayer).toHaveBeenCalledWith("leader", expect.any(Function));
    expect(recover).toHaveBeenCalledWith("leader", "player-death:one");
    expect(respawn).toHaveBeenCalledWith("leader");
    expect(order).toEqual(["penalty", "recovery", "respawn"]);
    expect(errors).toEqual([]);
  });

  it("returns a retryable error when penalty settlement fails", async () => {
    const { handler, errors } = respawnHandlerFor(vi.fn(async () => {
      throw new Error("database unavailable");
    }));
    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-2" });
    expect(errors).toEqual([expect.objectContaining({
      requestId: "respawn-2",
      code: "RESPAWN_RETRY_REQUIRED",
      retryable: true
    })]);
  });

  it("logs the underlying recovery failure with player and request identifiers", async () => {
    const logger = { warn: vi.fn() };
    const { handler } = respawnHandlerFor(vi.fn(async () => {
      throw new Error("projection unavailable");
    }), [], undefined, logger);

    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-log" });

    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), playerId: "leader", requestId: "respawn-log" },
      "player respawn recovery failed"
    );
  });

  it("keeps a room-respawn dungeon player inside: settles the penalty and respawns without world recovery", async () => {
    const order: string[] = [];
    const settleAndRespawnPlayer = vi.fn(async (_playerId, complete) => {
      order.push("penalty");
      return complete("player-death:vault");
    });
    const respawnsInRoomOnDeath = vi.fn((playerId: string) => playerId === "leader");
    const { handler, errors, recover, respawn } = respawnHandlerFor(
      settleAndRespawnPlayer, order, undefined, undefined, undefined, respawnsInRoomOnDeath
    );
    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-vault" });
    expect(respawnsInRoomOnDeath).toHaveBeenCalledWith("leader");
    expect(recover).not.toHaveBeenCalled();
    expect(respawn).toHaveBeenCalledWith("leader");
    expect(order).toEqual(["penalty", "respawn"]);
    expect(errors).toEqual([]);
  });

  it("still recovers to the world when the player is not in a room-respawn dungeon", async () => {
    const order: string[] = [];
    const settle = vi.fn(async (_playerId, complete) => complete("player-death:world"));
    const { handler, recover, respawn } = respawnHandlerFor(
      settle, order, undefined, undefined, undefined, vi.fn(() => false)
    );
    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-world" });
    expect(recover).toHaveBeenCalledWith("leader", "player-death:world");
    expect(respawn).toHaveBeenCalledWith("leader");
    expect(order).toEqual(["recovery", "respawn"]);
  });

  it("rejects an early respawn before settlement or recovery", async () => {
    const settleAndRespawnPlayer = vi.fn(async () => true);
    const { handler, errors, recover, respawn } = respawnHandlerFor(
      settleAndRespawnPlayer,
      [],
      { ready: false, remainingMs: 9_001 }
    );
    await handler({ type: "RESPAWN_PLAYER", requestId: "respawn-early" });
    expect(settleAndRespawnPlayer).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(errors).toEqual([expect.objectContaining({
      requestId: "respawn-early",
      code: "RESPAWN_DELAY_ACTIVE",
      message: "Respawn is available in 10 seconds.",
      retryable: true
    })]);
  });
});

function respawnHandlerFor(
  settleAndRespawnPlayer: (
    playerId: string,
    complete: (operationKey: string) => Promise<boolean>
  ) => Promise<boolean>,
  order: string[] = [],
  readiness: { ready: boolean; remainingMs: number } = { ready: true, remainingMs: 0 },
  logger: { warn: ReturnType<typeof vi.fn> } = { warn: vi.fn() },
  playerAuthorityFence?: PlayerAuthorityFence,
  respawnsInRoomOnDeath?: (playerId: string) => boolean
) {
  const errors: Array<Record<string, unknown>> = [];
  const recover = vi.fn(async () => {
    if (playerAuthorityFence) {
      await playerAuthorityFence.run("leader", async () => { order.push("recovery"); });
    } else order.push("recovery");
  });
  const respawn = vi.fn(() => { order.push("respawn"); return {}; });
  const context = {
    state: { playerId: "leader", connectionId: "connection-1" },
    socket: {} as SocketLike,
    logger,
    combat: { respawnPlayer: respawn, respawnReadiness: () => readiness } as unknown as CombatEngine,
    settleAndRespawnPlayer,
    recoverPlayerToWorldAnchor: recover,
    respawnsInRoomOnDeath,
    playerAuthorityFence,
    sendCombatError: (
      _socket: SocketLike,
      requestId: string,
      code: string,
      message: string,
      details?: Record<string, unknown>
    ) => errors.push({ requestId, code, message, ...details })
  } as unknown as CombatEquipmentHandlerContext;
  return { handler: createCombatEquipmentHandler(context), errors, recover, respawn };
}

function handlerFor(input: {
  resetStartingEvent: ReturnType<typeof vi.fn>;
  activateStartedEvent: ReturnType<typeof vi.fn>;
  recenterXoralParticipant: ReturnType<typeof vi.fn>;
  sent: Array<{ playerId: string; message: ServerMessage }>;
}) {
  const xoralEvents = {
    start: vi.fn(async () => startResult),
    resetStartingEvent: input.resetStartingEvent,
    activateStartedEvent: input.activateStartedEvent,
    isStartingPartyCurrent: vi.fn(() => true)
  } as unknown as XoralEventService;
  const context = {
    state: { playerId: "leader", connectionId: "connection-1" },
    socket: {} as SocketLike,
    registry: {
      send: (playerId: string, message: ServerMessage) => {
        input.sent.push({ playerId, message });
      }
    } as unknown as ConnectionRegistry,
    gameState: {
      isWorldPresent: () => true,
      getPlayer: (playerId: string) => ({
        username: playerId === "leader" ? "Leader" : "Member"
      })
    } as unknown as GameState,
    xoralEvents,
    recenterXoralParticipant: input.recenterXoralParticipant,
    safeSendServerMessage: (_socket: SocketLike, message: ServerMessage) => {
      input.sent.push({ playerId: "leader", message });
      return true;
    }
  } as unknown as CombatEquipmentHandlerContext;
  return createCombatEquipmentHandler(context);
}

describe("START_ATTACK land-action gate", () => {
  function attackHandler(targetIsPlayer: boolean) {
    const check = vi.fn(async () => ({
      allowed: false as const,
      code: "LAND_ACTION_SETTLING" as const,
      message: "Try again later." as const,
      retryAfterMs: 60_000
    }));
    const enqueueWorldCommand = vi.fn(() => true);
    const sendCombatError = vi.fn();
    const context = {
      state: { playerId: "attacker", connectionId: "connection-1" },
      socket: {} as SocketLike,
      authenticatedSession: { account: { id: "account-1" } },
      landActions: { check, recordLandAction: vi.fn(async () => undefined) },
      gameState: {
        isMovementBlocked: () => false,
        getPlayer: (playerId: string) =>
          playerId === "attacker" || (targetIsPlayer && playerId === "target")
            ? { playerId, position: { lat: 40, lon: -105 } }
            : undefined
      } as unknown as GameState,
      combat: {} as CombatEngine,
      worldRuntime: {},
      classRealtimeState: { hasActiveMutation: () => false },
      cancelPendingManorEntry: vi.fn(),
      enforcePlayerClassRate: vi.fn(),
      enqueueWorldCommand,
      sendCombatError
    } as unknown as CombatEquipmentHandlerContext;
    return { handler: createCombatEquipmentHandler(context), check, enqueueWorldCommand, sendCombatError };
  }

  const attack = { type: "START_ATTACK", requestId: "attack-1", targetEntityId: "target" } as const;

  it("refuses PvP engagement during an enforced hold before enqueueing", async () => {
    const { handler, check, enqueueWorldCommand, sendCombatError } = attackHandler(true);

    await handler(attack as never);

    expect(check).toHaveBeenCalledWith(expect.objectContaining({ action: "pvp_engage", accountId: "account-1" }));
    expect(enqueueWorldCommand).not.toHaveBeenCalled();
    expect(sendCombatError).toHaveBeenCalledWith(
      expect.anything(), "attack-1", "LAND_ACTION_SETTLING", "Try again later.",
      { retryable: true, retryAfterMs: 60_000 }
    );
  });

  it("never gates attacks on monsters", async () => {
    const { handler, check, enqueueWorldCommand } = attackHandler(false);

    await handler(attack as never);

    expect(check).not.toHaveBeenCalled();
    expect(enqueueWorldCommand).toHaveBeenCalledOnce();
  });
});

describe("CRAFT_EQUIPMENT portable crafts", () => {
  function craftHandler(transitioning = false) {
    const sent: ServerMessage[] = [];
    const craftStockEquipment = vi.fn(async (
      _actor: unknown,
      _familyId: string,
      _requestId: string,
      authority: { kind: string; authorize(): Promise<void> }
    ) => {
      await authority.authorize();
      return {
        applied: true,
        replayed: false,
        action: "craft",
        definitionId: "wooden_axe",
        instanceId: "00000000-0000-4000-8000-000000000031",
        materialCosts: [{ itemId: "wood", quantity: 20 }],
        goldCost: "0",
        inventory: {},
        equipment: {},
        message: "Crafted Wooden Axe."
      };
    });
    const context = {
      state: { playerId: "crafter", connectionId: "connection-1" },
      socket: {} as SocketLike,
      authenticatedSession: { account: { id: "account-1" } },
      equipment: { craftStockEquipment },
      worldRuntime: { hasPlayerWorldTransition: () => transitioning },
      classRealtimeState: { beginMutation: () => Symbol("craft"), endMutation: vi.fn() },
      safeSendServerMessage: (_socket: SocketLike, message: ServerMessage) => {
        sent.push(message);
        return true;
      }
    } as unknown as CombatEquipmentHandlerContext;
    return { handler: createCombatEquipmentHandler(context), craftStockEquipment, sent };
  }

  it("crafts a starter tool on the player without a Smithing Station session", async () => {
    const { handler, craftStockEquipment, sent } = craftHandler();
    await handler({ type: "CRAFT_EQUIPMENT", requestId: "craft-axe", familyId: "wooden_axe" });
    expect(craftStockEquipment).toHaveBeenCalledWith(
      { playerId: "crafter", accountId: "account-1" },
      "wooden_axe",
      "craft-axe",
      expect.objectContaining({ kind: "portable_craft" }),
      undefined
    );
    expect(sent).toEqual([expect.objectContaining({ type: "EQUIPMENT_ACQUIRED", requestId: "craft-axe" })]);
  });

  it("still requires the Smithing Station for every other recipe", async () => {
    const { handler, craftStockEquipment, sent } = craftHandler();
    await handler({ type: "CRAFT_EQUIPMENT", requestId: "craft-sword", familyId: "sword" });
    await handler({
      type: "CRAFT_EQUIPMENT",
      requestId: "craft-half",
      familyId: "wooden_axe",
      manorSessionId: "00000000-0000-4000-8000-000000000010"
    });
    expect(craftStockEquipment).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({ type: "ERROR", requestId: "craft-sword", code: "MANOR_SMITH_ACCESS_DENIED" }),
      expect.objectContaining({ type: "ERROR", requestId: "craft-half", code: "EQUIPMENT_INVALID_REQUEST" })
    ]);
  });

  it("refuses a portable craft during a world transition", async () => {
    const { handler, sent } = craftHandler(true);
    await handler({ type: "CRAFT_EQUIPMENT", requestId: "craft-travel", familyId: "stone_pickaxe" });
    expect(sent).toEqual([expect.objectContaining({ type: "ERROR", requestId: "craft-travel" })]);
  });
});
