import type pg from "pg";
import { merchantMaximizeTacticsCostGold, type PlayerInventorySnapshot } from "@ash-atlas/shared";

import { CombatRequestError, type CombatEngine } from "./combatEngine.js";
import type { InventoryService } from "../inventory.js";
import type { PlayerAuthorityFence } from "../playerAuthorityFence.js";
import { WalletOperationError, type WalletService } from "../wallet.js";

export type MerchantMaximizeTacticsResult = Readonly<{
  replayed: boolean;
  costGold: number;
  walletGold: string;
  walletVersion: string;
  inventory: PlayerInventorySnapshot;
}>;

/**
 * Merchant Rank 1 "Maximize Tactics": 9 Gold per character level (level capped at 33) buys a full
 * stored-Tactics bar. The Gold debit is keyed on the request id, so a replayed request neither
 * charges nor refills again; an unrelated second request is rejected once Tactics is full.
 */
export class MerchantMaximizeTacticsService {
  constructor(private readonly deps: Readonly<{
    pool: Pick<pg.Pool, "connect">;
    inventory: Pick<InventoryService, "snapshotInTransaction">;
    wallet: Pick<WalletService, "debitForOperationInTransaction" | "snapshot">;
    combat: Pick<CombatEngine, "merchantMaximizeTacticsState" | "applyMerchantMaximizeTactics">;
    fence: Pick<PlayerAuthorityFence, "run">;
  }>) {}

  use(input: { playerId: string; accountId: string; connectionId: string; requestId: string }): Promise<MerchantMaximizeTacticsResult> {
    return this.deps.fence.run(input.playerId, () => this.useLocked(input));
  }

  private async useLocked(input: { playerId: string; accountId: string; connectionId: string; requestId: string }): Promise<MerchantMaximizeTacticsResult> {
    const operationKey = `merchant-maximize-tactics:${input.playerId}:${input.requestId}`;
    const client = await this.deps.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        "SELECT 1 FROM wallet_events WHERE operation_key = $1 AND player_id = $2",
        [operationKey, input.playerId]
      );
      if (prior.rowCount) {
        const snapshot = await this.deps.wallet.snapshot(input.playerId, input.accountId);
        const inventory = await this.deps.inventory.snapshotInTransaction(client, input.playerId);
        await client.query("ROLLBACK");
        committed = true;
        return { replayed: true, costGold: 0, walletGold: snapshot.gold, walletVersion: snapshot.revision, inventory };
      }
      const state = this.deps.combat.merchantMaximizeTacticsState(input.playerId, input.accountId, input.connectionId);
      const costGold = merchantMaximizeTacticsCostGold(state.characterLevel);
      let debit;
      try {
        debit = await this.deps.wallet.debitForOperationInTransaction(client, {
          playerId: input.playerId,
          accountId: input.accountId,
          amount: BigInt(costGold),
          operationKey,
          reason: "merchant_maximize_tactics",
          metadata: { characterLevel: state.characterLevel }
        });
      } catch (error) {
        if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
          throw new CombatRequestError("INSUFFICIENT_GOLD", `Maximize Tactics costs ${costGold} Gold`);
        }
        throw error;
      }
      const inventory = await this.deps.inventory.snapshotInTransaction(client, input.playerId);
      await client.query("COMMIT");
      committed = true;
      if (debit.applied) this.deps.combat.applyMerchantMaximizeTactics(input.playerId);
      return { replayed: !debit.applied, costGold, walletGold: debit.goldBalance.toString(), walletVersion: debit.version.toString(), inventory };
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
}
