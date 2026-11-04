export type LandBonusNotice = Readonly<{
  type: "LAND_BONUS_EARNED";
  gold: number;
  kills: number;
  walletGold: string;
  walletVersion: string;
}>;

type Pending = {
  gold: number;
  kills: number;
  walletGold: string;
  walletVersion: bigint;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Batches a land owner's hunting-bonus credits into one notice per window, so a
 * busy hunting ground sends at most one frame per owner per window instead of
 * one per kill. Ephemeral by design: the Gold itself is already in the wallet
 * ledger, the notice only tells an online owner about it.
 */
export class LandBonusNotifier {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: (playerId: string, notice: LandBonusNotice) => void,
    private readonly windowMs = 30_000
  ) {}

  record(ownerPlayerId: string, credit: Readonly<{ gold: number; walletGold: string; walletVersion: string }>): void {
    const version = BigInt(credit.walletVersion);
    const current = this.pending.get(ownerPlayerId);
    if (current) {
      current.gold += credit.gold;
      current.kills += 1;
      if (version > current.walletVersion) {
        current.walletVersion = version;
        current.walletGold = credit.walletGold;
      }
      return;
    }
    const timer = setTimeout(() => this.flush(ownerPlayerId), this.windowMs);
    timer.unref?.();
    this.pending.set(ownerPlayerId, {
      gold: credit.gold,
      kills: 1,
      walletGold: credit.walletGold,
      walletVersion: version,
      timer
    });
  }

  flush(ownerPlayerId: string): void {
    const entry = this.pending.get(ownerPlayerId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(ownerPlayerId);
    this.send(ownerPlayerId, {
      type: "LAND_BONUS_EARNED",
      gold: entry.gold,
      kills: entry.kills,
      walletGold: entry.walletGold,
      walletVersion: entry.walletVersion.toString()
    });
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
