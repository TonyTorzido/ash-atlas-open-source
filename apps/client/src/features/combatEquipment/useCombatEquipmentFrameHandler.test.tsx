// @vitest-environment jsdom

import type { WorldViewAuthority } from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { FloatingFeedbackState } from "../../combat/damageFloaters.js";
import {
  useCombatEquipmentFrameHandler
} from "./useCombatEquipmentFrameHandler.js";

describe("useCombatEquipmentFrameHandler world-view authority", () => {
  it("stores an authoritative death penalty from a progression snapshot", () => {
    const setProgression = vi.fn();
    const setDeathPenaltyXpLoss = vi.fn();
    const dispatchStartup = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      setProgression,
      setDeathPenaltyXpLoss,
      dispatchStartup
    } as never));
    const progression = { playerId: "player-1", totalXp: 14_364 };

    act(() => result.current({
      type: "PROGRESSION_SNAPSHOT",
      progression,
      deathPenalty: { operationKey: "player-death:one", xpLost: 906 }
    } as never));

    expect(setProgression).toHaveBeenCalledWith(progression);
    expect(setDeathPenaltyXpLoss).toHaveBeenCalledWith(906);
    expect(dispatchStartup).toHaveBeenCalledWith({ type: "progression" });

    act(() => result.current({ type: "PROGRESSION_SNAPSHOT", progression } as never));
    expect(setDeathPenaltyXpLoss).toHaveBeenCalledTimes(1);
  });

  it("routes legendary event alerts to the dedicated callback", () => {
    const onLegendaryEventAlert = vi.fn();
    const setWarning = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(), onLegendaryEventAlert, setWarning
    } as never));
    const message = { type: "LEGENDARY_EVENT_ALERT", eventId: "event-1", birdSpecies: "fire", flagId: "flag-1", message: "A Phoenix is attacking your flag!", selectedAt: "2098-12-31T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
    act(() => result.current(message as never));
    expect(onLegendaryEventAlert).toHaveBeenCalledWith(message);
    expect(setWarning).not.toHaveBeenCalled();
  });

  it("reconciles Skill System V3 snapshots by revision and settles only the matching request", () => {
    const setSkillSystemV3Busy = vi.fn();
    const setSkillSystemV3Error = vi.fn();
    const skillSystemV3RequestRef = { current: "skill-request-2" as string | null };
    let currentSnapshot: { revision: number } | null = { revision: 8 };
    const setSkillSystemV3Snapshot = vi.fn((update) => {
      currentSnapshot = typeof update === "function" ? update(currentSnapshot) : update;
    });
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      setSkillSystemV3Snapshot,
      setSkillSystemV3Busy,
      setSkillSystemV3Error,
      skillSystemV3RequestRef
    } as never));
    const snapshot = {
      playerId: "player-1",
      characterLevel: 10,
      pointState: { totalEarned: 20, totalSpent: 0, available: 20, revision: 7 },
      generalSkills: [],
      specializations: [],
      committedSpecializationId: null,
      activeSpecializationId: null,
      generalActiveLoadout: [null, null],
      ultimate: null,
      cooldownEndsAt: {},
      worldKnowledge: [],
      serverTime: 1_000,
      revision: 7
    };

    act(() => result.current({ type: "SKILL_TREE_SNAPSHOT", requestId: "stale-request", snapshot } as never));
    expect(currentSnapshot?.revision).toBe(8);
    expect(setSkillSystemV3Busy).not.toHaveBeenCalled();

    act(() => result.current({
      type: "SKILL_MUTATION_CONFIRMED",
      requestId: "skill-request-2",
      action: "spend",
      replayed: false,
      snapshot: { ...snapshot, pointState: { ...snapshot.pointState, revision: 9 }, revision: 9 }
    } as never));
    expect(currentSnapshot?.revision).toBe(9);
    expect(skillSystemV3RequestRef.current).toBeNull();
    expect(setSkillSystemV3Busy).toHaveBeenCalledWith(false);
    expect(setSkillSystemV3Error).toHaveBeenCalledWith(null);
  });

  it("reports the exact successful Xoral ring pickup request", () => {
    const onXoralRingDropPickedUp = vi.fn();
    const setEquipment = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      setEquipment,
      setWarning: vi.fn(),
      onXoralRingDropPickedUp
    } as never));
    const message = {
      type: "XORAL_RING_DROP_PICKED_UP" as const,
      requestId: "xoral-pickup-1",
      dropId: "drop-1",
      equipment: { playerId: "player-1", revision: 3 }
    };

    act(() => result.current(message as never));

    expect(setEquipment).toHaveBeenCalledWith(message.equipment);
    expect(onXoralRingDropPickedUp).toHaveBeenCalledWith(message);
  });

  it("applies ordinary snapshots without treating them as presentation checkpoints", () => {
    const observeCombat = vi.fn();
    const applySnapshot = vi.fn(() => "applied");
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ownPlayerId: "player-1",
      combatStore: { applySnapshot },
      worldViewBarrierRef: {
        current: { observeCombat }
      },
      combatServerClockOffsetMsRef: { current: 0 },
      overlayRef: { current: { clearCombatFeedback: vi.fn() } },
      snapRespawnedPlayers: vi.fn(),
      refreshCombatUi: vi.fn()
    } as never));

    act(() => result.current({
      type: "COMBAT_SNAPSHOT",
      state: {
        serverTime: 900,
        sequence: 3,
        entities: [],
        events: []
      }
    } as never));

    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(observeCombat).not.toHaveBeenCalled();
  });

  it("records an applied combat snapshot against its exact world-view epoch", () => {
    const observeCombat = vi.fn();
    const applySnapshot = vi.fn(() => "applied");
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ownPlayerId: "player-1",
      combatStore: { applySnapshot },
      worldViewBarrierRef: {
        current: { observeCombat }
      },
      combatServerClockOffsetMsRef: { current: 0 },
      overlayRef: { current: { clearCombatFeedback: vi.fn() } },
      snapRespawnedPlayers: vi.fn(),
      refreshCombatUi: vi.fn()
    } as never));

    act(() => result.current({
      type: "COMBAT_SNAPSHOT",
      state: {
        serverTime: 1_000,
        sequence: 4,
        entities: [],
        events: []
      },
      worldViewAuthority: AUTHORITY,
      combatSnapshotGeneration: 6
    } as never));

    expect(applySnapshot).toHaveBeenCalledOnce();
    expect(observeCombat).toHaveBeenCalledWith(AUTHORITY, 6);
  });

  it("preserves the displayed wallet through zero-Gold rewards and reconnect", () => {
    const renderWallet = () => renderHook(() => {
      const [rewardWallet, setRewardWallet] = useState<string | null>(null);
      const handle = useCombatEquipmentFrameHandler({
        ...combatHandlerOptions(),
        setWalletGold: setRewardWallet
      } as never);
      return {
        handle,
        displayedWallet: rewardWallet ?? "47"
      };
    });
    const first = renderWallet();

    act(() => first.result.current.handle(rewardMessage({
      gold: 0,
      items: [{ itemId: "leather", quantity: 1 }]
    }) as never));
    expect(first.result.current.displayedWallet).toBe("47");

    first.unmount();
    const reconnected = renderWallet();
    expect(reconnected.result.current.displayedWallet).toBe("47");

    act(() => reconnected.result.current.handle(rewardMessage({
      gold: 5,
      walletGold: "52",
      walletVersion: "2"
    }) as never));
    expect(reconnected.result.current.displayedWallet).toBe("52");
  });

  it("ignores malformed, missing, zero-Gold, and stale combat wallet updates", () => {
    const setWalletGold = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      setWalletGold
    } as never));

    act(() => {
      result.current(rewardMessage({
        gold: 0,
        walletGold: "0",
        walletVersion: "0"
      }) as never);
      result.current(rewardMessage({
        gold: 5,
        walletGold: "not-an-integer",
        walletVersion: "2"
      }) as never);
      result.current(rewardMessage({
        gold: 5,
        walletGold: "52"
      }) as never);
      result.current(rewardMessage({
        gold: 5,
        walletGold: "52",
        walletVersion: "2"
      }) as never);
      result.current(rewardMessage({
        gold: 5,
        walletGold: "51",
        walletVersion: "1"
      }) as never);
    });

    expect(setWalletGold).toHaveBeenCalledOnce();
    expect(setWalletGold).toHaveBeenCalledWith("52", "2");
  });

  it("shows committed item quantities once per type before unchanged Gold feedback", () => {
    const feedback = new FloatingFeedbackState();
    const enqueueFloatingFeedback = vi.fn((entry) => {
      feedback.enqueue([entry], 100);
    });
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      overlayRef: { current: { enqueueFloatingFeedback } }
    } as never));
    const message = rewardMessage({
      items: [
        { itemId: "deer_hide", quantity: 2 },
        { itemId: "atlas_shrine_shard", quantity: 1 }
      ],
      drops: [{ itemId: "deer_hide", quantity: 1 }],
      gold: 7,
      walletGold: "54",
      walletVersion: "2"
    });

    act(() => {
      result.current(message as never);
      result.current(message as never);
    });

    expect(feedback.floaters().map(({ eventId, kind, amount, icon, label }) => ({
      eventId, kind, amount, icon, label
    }))).toEqual([
      {
        eventId: "combat-item:mob:wolf:1:defeat:1:deer_hide",
        kind: "resource",
        amount: 2,
        icon: "deer_hide",
        label: "×2"
      },
      {
        eventId: "combat-item:mob:wolf:1:defeat:1:atlas_shrine_shard",
        kind: "resource",
        amount: 1,
        icon: "atlas_shrine_shard",
        label: "×1"
      },
      {
        eventId: "gold:mob:wolf:1:defeat:1",
        kind: "gold",
        amount: 7,
        icon: undefined,
        label: undefined
      }
    ]);
    expect(enqueueFloatingFeedback).toHaveBeenNthCalledWith(1, expect.objectContaining({
      icon: "deer_hide",
      label: "×2"
    }));
    expect(enqueueFloatingFeedback).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: "gold",
      amount: 7
    }));
  });

  it("does not present ground overflow as an inventory reward", () => {
    const enqueueFloatingFeedback = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      overlayRef: { current: { enqueueFloatingFeedback } }
    } as never));

    act(() => result.current(rewardMessage({
      items: [],
      drops: [{ itemId: "wolf_pelt", quantity: 1 }],
      gold: 0
    }) as never));

    expect(enqueueFloatingFeedback).not.toHaveBeenCalled();
  });

  it("labels class XP with the frozen awarded class", () => {
    const enqueueFloatingFeedback = vi.fn();
    const setClassSnapshot = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      setClassSnapshot,
      overlayRef: { current: { enqueueFloatingFeedback } }
    } as never));
    const snapshot = { activeClassId: "warrior" };

    act(() => result.current({
      type: "CLASS_MASTERY_GRANTED",
      eventId: "class-xp:mob:defeat:player-1",
      classId: "ranger",
      subclassId: null,
      requestedXp: 12,
      grantedXp: 12,
      replayed: false,
      previousRank: 0,
      resultingRank: 0,
      snapshot
    } as never));

    expect(setClassSnapshot).toHaveBeenCalledWith(snapshot);
    expect(enqueueFloatingFeedback).toHaveBeenCalledWith({
      eventId: "class-xp:mob:defeat:player-1",
      targetEntityId: "player-1",
      kind: "class_xp",
      amount: 12,
      subject: "Ranger",
      label: "+12 Ranger XP"
    });
  });

  it("retains authoritative Bitter Blood progress and unlock snapshots", () => {
    const setAchievements = vi.fn();
    const { result } = renderHook(() => useCombatEquipmentFrameHandler({
      ...combatHandlerOptions(),
      setAchievements
    } as never));
    const achievements = {
      playerId: "player-1",
      achievements: [{
        achievementId: "bitter_blood",
        title: "Bitter Blood",
        badgeId: "bitter_blood",
        completed: false,
        completedAt: null,
        statKey: "poison_damage_taken",
        value: 184,
        requiredValue: 250
      }],
      serverTime: 1
    };

    act(() => result.current({
      type: "ACHIEVEMENT_SNAPSHOT",
      achievements
    } as never));

    expect(setAchievements).toHaveBeenCalledWith(achievements);
  });
});

const AUTHORITY: WorldViewAuthority = {
  playerId: "player-1",
  connectionId: "connection-1",
  connectionGeneration: 2,
  relocationRevision: 3,
  resourceVisionRevision: 4,
  gameplayViewGeneration: 5,
  populationPreparationGeneration: 6
};

function combatHandlerOptions() {
  return {
    ownPlayerId: "player-1",
    receiveInventorySnapshot: vi.fn(),
    setWalletGold: vi.fn(),
    currentWalletGold: "47",
    refreshMarket: vi.fn(),
    combatServerClockOffsetMsRef: { current: 0 },
    overlayRef: { current: null }
  };
}

function rewardMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "COMBAT_REWARD_GRANTED",
    settlementKey: "mob:wolf:1:defeat:1",
    playerId: "player-1",
    items: [],
    drops: [],
    gold: 0,
    inventory: {
      playerId: "player-1",
      revision: 2,
      items: [],
      totals: {
        wood: 0,
        stone: 0,
        food: 0,
        ore: 0,
        water: 0,
        leather: 0,
        giving_berry: 0,
        balsam_resin: 0,
        crystal: 0, pearl: 0, atlas_shrine_shard: 0,
        enchantment_stone: 0
      }
    },
    cityCoins: 0,
    cityId: null,
    cityTreasuryBalance: null,
    cityContribution: null,
    ...overrides
  };
}
