import { describe, expect, it, vi } from "vitest";

import { getTravelBlockReason } from "./travelEligibility.js";

describe("getTravelBlockReason", () => {
  const state = (options: {
    online?: boolean;
    present?: boolean;
    cityConstruction?: boolean;
    fishing?: boolean;
  } = {}) => ({
    getPlayer: () => ({ online: options.online ?? true }),
    isWorldPresent: () => options.present ?? true,
    isMovementBlocked: (_playerId: string, reason?: string) =>
      (reason === "city-construction" && options.cityConstruction === true) ||
      (reason === "fishing" && options.fishing === true)
  });

  it("shares aggressive restrictions and retry timing", () => {
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state() as never,
      combat: {
        hasQueuedAbility: vi.fn(() => false),
        isPlayerAlive: vi.fn(() => true),
        isInCombat: vi.fn(() => false),
        aggressionRemainingMs: vi.fn(() => 6_500)
      } as never
    })).toEqual({
      code: "TRAVEL_AGGRESSIVE",
      message: "Cannot travel while Aggressive. 6.5s remaining.",
      retryAfterMs: 6_500
    });
  });

  it("automatically propagates common pending-action restrictions", () => {
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state({ cityConstruction: true }) as never
    })?.code).toBe("CITY_CONSTRUCTION_ACTIVE");
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state({ fishing: true }) as never
    })).toEqual({
      code: "FISHING_ACTIVE",
      message: "Leave the active Fishing encounter before travelling."
    });
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state() as never,
      worldRuntime: { hasPendingCommand: vi.fn(() => true) } as never
    })?.code).toBe("PLAYER_WORLD_COMMAND_PENDING");
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state() as never,
      hasActiveClassMutation: () => true
    })?.code).toBe("CLASS_MUTATION_PENDING");
  });

  it("rejects defeat but allows incoming-only combat until the player becomes Aggressive", () => {
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state() as never,
      combat: {
        hasQueuedAbility: vi.fn(() => false),
        isPlayerAlive: vi.fn(() => false)
      } as never
    })?.code).toBe("TRAVEL_PLAYER_DEFEATED");
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state() as never,
      combat: {
        hasQueuedAbility: vi.fn(() => false),
        isPlayerAlive: vi.fn(() => true),
        isInCombat: vi.fn(() => true),
        aggressionRemainingMs: vi.fn(() => 0)
      } as never
    })).toBeNull();
  });

  it.each([
    ["leader", "XORAL_LEADER_EXIT_CONFIRMATION_REQUIRED"],
    ["follower", "XORAL_FOLLOWER_EXIT_CONFIRMATION_REQUIRED"]
  ] as const)("requires explicit confirmation before a Xoral %s relocates", (role, code) => {
    expect(getTravelBlockReason({
      playerId: "player-a",
      gameState: state() as never,
      xoralExitRole: () => role
    })?.code).toBe(code);
  });
});
