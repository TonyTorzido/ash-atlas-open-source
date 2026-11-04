import type { WanderingMerchantShopSnapshot } from "@ash-atlas/shared";

import { GameAppCard, GameAppShell } from "./GameAppShell.js";

/** Shop for the player's own Wandering Merchant; the server enforces every price and limit. */
export function WanderingMerchantPanel({
  open,
  snapshot,
  busy,
  layout,
  onBuy,
  onClose
}: Readonly<{
  open: boolean;
  snapshot: WanderingMerchantShopSnapshot | null;
  busy: boolean;
  layout: "desktop" | "phone";
  onBuy(itemId: string, quantity: number, unitPriceGold: string): void;
  onClose(): void;
}>): React.JSX.Element | null {
  if (!open) return null;
  return <GameAppShell open title="Wandering Merchant" closeLabel="Close Wandering Merchant" layout={layout} onClose={onClose}>
    {snapshot ? <p>
      {snapshot.walletGold} Gold
      {snapshot.discountPercent > 0 ? ` · Tradecraft ${snapshot.rank}: ${snapshot.discountPercent}% off` : ""}
      {` · Leaves ${new Date(snapshot.expiresAt).toLocaleTimeString()}`}
    </p> : <p>The merchant is laying out wares...</p>}
    {snapshot?.lines.map((line) => <GameAppCard
      key={line.itemId}
      title={line.displayName}
      badge={line.unitPriceGold === line.baseUnitPriceGold
        ? `${line.unitPriceGold} Gold each`
        : `${line.unitPriceGold} Gold each (was ${line.baseUnitPriceGold})`}
      action={<button type="button" disabled={busy || line.remaining <= 0}
        onClick={() => onBuy(line.itemId, 1, line.unitPriceGold)}>{line.remaining > 0 ? "Buy 1" : "Sold out"}</button>}
    ><span>{line.remaining} left</span></GameAppCard>)}
  </GameAppShell>;
}
