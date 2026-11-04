import type { RiskEventInput } from "./types.js";

export const RISK_WEIGHTS = {
  secondAccountSameDevice: 25,
  additionalAccountSameDevice: 15,
  rapidAccountSwitching: 20,
  threeNewAccountsNetwork: 20,
  fiveNewAccountsNetwork: 40
} as const;

export interface RiskEventStore {
  insertRiskEvent(input: RiskEventInput): Promise<boolean>;
  recomputeAccountRiskScore(accountId: string): Promise<number>;
}

export class AccountRiskService {
  constructor(private readonly store: RiskEventStore) {}

  async record(input: RiskEventInput): Promise<number> {
    await this.store.insertRiskEvent(input);
    return this.recompute(input.accountId);
  }

  async recompute(accountId: string): Promise<number> {
    return this.store.recomputeAccountRiskScore(accountId);
  }
}

export function clampRiskScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}
