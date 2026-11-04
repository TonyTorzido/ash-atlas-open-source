import {
  emptyInventoryTotals,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  publishCommittedCombatReward
} from "./application.js";
import type {
  CombatSettlementResult
} from "./game/combat/rewardSettlement.js";
import { COMBAT_ITEM_REWARD_POLICY_VERSION } from "./game/combat/mobDefinitions.js";
import type { InventoryService } from "./game/inventory.js";
import type { AppLogger } from "./logger.js";
import type {
  ConnectionRegistry,
  SendResult
} from "./realtime/connectionRegistry.js";

describe("committed combat reward publication", () => {
  it("does not resync when both committed reward messages are sent", async () => {
    const fixture = publicationFixture(["sent", "sent"]);

    await publishCommittedCombatReward(
      combatReward(inventory(1, 7)),
      fixture.registry,
      fixture.inventory,
      fixture.logger
    );

    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.send.mock.calls[1]?.[1]).toMatchObject({
      type: "COMBAT_REWARD_GRANTED",
      settlementKey: "deer:defeat:1",
      items: [{ itemId: "leather", quantity: 1 }]
    });
    expect(fixture.getInventorySnapshot).not.toHaveBeenCalled();
    expect(fixture.warn).not.toHaveBeenCalled();
  });

  it.each(["missing", "closed", "not-open"] as const)(
    "resyncs authoritative inventory once when reward publication is %s",
    async (failedPublication) => {
      const fixture = publicationFixture([
        "sent",
        failedPublication,
        "sent"
      ], inventory(1, 8));

      await publishCommittedCombatReward(
        combatReward(inventory(1, 7)),
        fixture.registry,
        fixture.inventory,
        fixture.logger
      );

      expect(fixture.getInventorySnapshot)
        .toHaveBeenCalledOnce();
      expect(fixture.getInventorySnapshot)
        .toHaveBeenCalledWith("reward-player");
      expect(fixture.send).toHaveBeenCalledTimes(3);
      expect(fixture.send.mock.calls[2]?.[1]).toMatchObject({
        type: "PLAYER_RESOURCES_UPDATED",
        playerId: "reward-player",
        inventory: {
          revision: 8,
          totals: { leather: 1 }
        }
      });
      expect(fixture.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementKey: "deer:defeat:1",
          operationKey: "combat-items:deer:defeat:1",
          playerId: "reward-player",
          inventoryRevision: 7,
          inventoryPublication: "sent",
          rewardPublication: failedPublication,
          resyncPublication: "sent",
          currentConnectionId: "connection-1"
        }),
        "combat-reward-committed-publication-failed"
      );
    }
  );

  it("resyncs once when publication throws before returning an outcome", async () => {
    const fixture = publicationFixture(["sent", "sent"]);
    fixture.send.mockImplementationOnce(() => {
      throw new Error("serialization failed");
    });

    await publishCommittedCombatReward(
      combatReward(inventory(1, 7)),
      fixture.registry,
      fixture.inventory,
      fixture.logger
    );

    expect(fixture.getInventorySnapshot).toHaveBeenCalledOnce();
    expect(fixture.send).toHaveBeenCalledTimes(3);
    expect(fixture.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        inventoryPublication: "failed",
        inventoryPublicationError: expect.any(Error),
        rewardPublication: "sent",
        resyncPublication: "sent"
      }),
      "combat-reward-committed-publication-failed"
    );
  });

  it("omits wallet fields when the committed reward did not mutate Gold", async () => {
    const fixture = publicationFixture(["sent", "sent"]);
    const result = combatReward(inventory(1, 7));
    result.mobReward!.gold = 0;
    delete result.mobReward!.walletGold;
    delete result.mobReward!.walletVersion;

    await publishCommittedCombatReward(
      result,
      fixture.registry,
      fixture.inventory,
      fixture.logger
    );

    const published = fixture.send.mock.calls[1]?.[1];
    expect(published).toMatchObject({ type: "COMBAT_REWARD_GRANTED", gold: 0 });
    expect(published).not.toHaveProperty("walletGold");
    expect(published).not.toHaveProperty("walletVersion");
  });
});

function publicationFixture(
  outcomes: SendResult[],
  authoritativeInventory = inventory(1, 8)
): {
  registry: Pick<
    ConnectionRegistry,
    "send" | "activeConnectionIdForPlayer"
  >;
  inventory: Pick<InventoryService, "getInventorySnapshot">;
  logger: Pick<AppLogger, "warn">;
  send: ReturnType<typeof vi.fn>;
  getInventorySnapshot: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => outcomes.shift() ?? "sent");
  const getInventorySnapshot = vi.fn(async () => authoritativeInventory);
  const warn = vi.fn();
  return {
    registry: {
      send,
      activeConnectionIdForPlayer: () => "connection-1"
    } as Pick<
      ConnectionRegistry,
      "send" | "activeConnectionIdForPlayer"
    >,
    inventory: { getInventorySnapshot },
    logger: { warn } as Pick<AppLogger, "warn">,
    send,
    getInventorySnapshot,
    warn
  };
}

function combatReward(
  rewardInventory: PlayerInventorySnapshot
): CombatSettlementResult {
  return {
    settlementKey: "deer:defeat:1",
    mobArchetype: "deer",
    mobLevel: 2,
    mobBalanceVersion: 2,
    xpPolicyVersion: 3,
    itemRewardPolicyVersion: COMBAT_ITEM_REWARD_POLICY_VERSION,
    targetBasicHitCount: 2,
    baseXpPool: 24,
    calculatedXpPool: 25,
    classXpPolicyVersion: 1,
    baseClassXpPool: 4,
    groupSize: 1,
    shares: [],
    mobReward: {
      playerId: "reward-player",
      items: [{ itemId: "leather", quantity: 1 }],
      gold: 15,
      inventory: rewardInventory,
      walletGold: "15",
      walletVersion: "1",
      cityCoins: 0,
      cityId: null,
      cityTreasuryBalance: null,
      cityContribution: null
    },
    replayed: false
  };
}

function inventory(
  leather: number,
  revision: number
): PlayerInventorySnapshot {
  return {
    playerId: "reward-player",
    revision,
    items: leather > 0
      ? [{
          playerId: "reward-player",
          resourceType: "leather",
          variant: null,
          quantity: leather
        }]
      : [],
    totals: { ...emptyInventoryTotals(), leather },
    unlockedSlots: 16
  };
}
