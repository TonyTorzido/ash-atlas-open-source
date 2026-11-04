import { describe, expect, it } from "vitest";

import { CombatRequestError } from "./combatEngine.js";
import { MerchantMaximizeTacticsService } from "./merchantMaximizeTactics.js";
import { WalletOperationError } from "../wallet.js";

function setup(options: { gold: number; level: number; tactics?: { current: number; maximum: number } }) {
  const ledger = new Set<string>();
  const state = { gold: options.gold, version: 1, applied: 0, tactics: options.tactics?.current ?? 0, charges: [] as number[] };
  const maximum = options.tactics?.maximum ?? 4;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT 1 FROM wallet_events")) return { rowCount: ledger.has(String(params?.[0])) ? 1 : 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release: () => undefined
  };
  const service = new MerchantMaximizeTacticsService({
    pool: { connect: async () => client } as never,
    inventory: { snapshotInTransaction: async () => ({ marker: "inventory" }) } as never,
    wallet: {
      snapshot: async () => ({ playerId: "p", gold: String(state.gold), revision: String(state.version) }),
      debitForOperationInTransaction: async (_client: unknown, input: { amount: bigint; operationKey: string }) => {
        if (ledger.has(input.operationKey)) return { applied: false, goldBalance: BigInt(state.gold), version: BigInt(state.version) };
        if (BigInt(state.gold) < input.amount) throw new WalletOperationError("WALLET_INSUFFICIENT_FUNDS", "no");
        ledger.add(input.operationKey);
        state.gold -= Number(input.amount);
        state.version += 1;
        state.charges.push(Number(input.amount));
        return { applied: true, goldBalance: BigInt(state.gold), version: BigInt(state.version) };
      }
    } as never,
    combat: {
      merchantMaximizeTacticsState: () => {
        if (state.tactics >= maximum) throw new CombatRequestError("TACTICS_ALREADY_MAXIMIZED", "full");
        return { characterLevel: options.level, current: state.tactics, maximum };
      },
      applyMerchantMaximizeTactics: () => { state.applied += 1; state.tactics = maximum; }
    } as never,
    fence: { run: (_id: string, operation: () => Promise<unknown>) => operation() } as never
  });
  return { service, state };
}

const input = { playerId: "p", accountId: "a", connectionId: "c" };

describe("MerchantMaximizeTacticsService", () => {
  it("debits 9 gold per level (level capped at 33) and fills Tactics", async () => {
    const { service, state } = setup({ gold: 1000, level: 40 });
    const result = await service.use({ ...input, requestId: "r1" });
    expect(result).toMatchObject({ replayed: false, costGold: 297, walletGold: "703" });
    expect(state).toMatchObject({ gold: 703, applied: 1, tactics: 4, charges: [297] });
    const low = setup({ gold: 1000, level: 12 });
    await expect(low.service.use({ ...input, requestId: "r1" })).resolves.toMatchObject({ costGold: 108 });
  });

  it("rejects without charging when gold is short or Tactics is already full", async () => {
    const poor = setup({ gold: 80, level: 10 });
    await expect(poor.service.use({ ...input, requestId: "r1" })).rejects.toMatchObject({ code: "INSUFFICIENT_GOLD" });
    expect(poor.state).toMatchObject({ gold: 80, applied: 0, charges: [] });
    const full = setup({ gold: 1000, level: 10, tactics: { current: 4, maximum: 4 } });
    await expect(full.service.use({ ...input, requestId: "r1" })).rejects.toMatchObject({ code: "TACTICS_ALREADY_MAXIMIZED" });
    expect(full.state.gold).toBe(1000);
  });

  it("does not charge or refill again when the same request id is replayed", async () => {
    const { service, state } = setup({ gold: 1000, level: 10 });
    await service.use({ ...input, requestId: "same" });
    state.tactics = 0;
    const replay = await service.use({ ...input, requestId: "same" });
    expect(replay).toMatchObject({ replayed: true, costGold: 0, walletGold: "910" });
    expect(state).toMatchObject({ gold: 910, applied: 1, charges: [90], tactics: 0 });
  });
});
