import { useState } from "react";
import type { GoblinMarketBuyLine, GoblinMarketLine, GoblinMarketSnapshot } from "@ash-atlas/shared";

import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { GameAppCard, GameAppShell, GameAppTabs } from "./GameAppShell.js";

export function GoblinMarketPanel({
  open,
  snapshot,
  busy,
  layout,
  onSell,
  onBuy,
  onClose
}: Readonly<{
  open: boolean;
  snapshot: GoblinMarketSnapshot | null;
  busy: boolean;
  layout: "desktop" | "phone";
  onSell(line: GoblinMarketLine): void;
  onBuy(line: GoblinMarketBuyLine): void;
  onClose(): void;
}>): React.JSX.Element | null {
  const [activeTab, setActiveTab] = useState<"buy" | "sell">("buy");
  const [pending, setPending] = useState<
    { action: "buy"; line: GoblinMarketBuyLine } |
    { action: "sell"; line: GoblinMarketLine } |
    null
  >(null);
  if (!open) return null;
  return <>
    <GameAppShell
      open
      title="Goblin Market"
      closeLabel="Close Goblin Market"
      layout={layout}
      onClose={onClose}
    >
      <GameAppTabs
        tabs={[
          { id: "buy", label: "Buy", badge: String(snapshot?.buyLines.length ?? 0) },
          { id: "sell", label: "Sell", badge: String(snapshot?.lines.length ?? 0) }
        ]}
        activeTab={activeTab}
        variant="housed"
        onChange={(tab) => {
          if (tab === "buy" || tab === "sell") setActiveTab(tab);
        }}
      />
      {activeTab === "buy" ? (
        snapshot?.buyLines.length ? snapshot.buyLines.map((line) => <GameAppCard
          key={`${line.kind}:${line.identity}`}
          title={line.displayName}
          badge={`${line.unitPriceGold} Gold each`}
          action={<button type="button" disabled={busy} onClick={() => setPending({ action: "buy", line })}>
            Buy 1
          </button>}
        ><span>Stock ×{line.quantity}</span></GameAppCard>) :
          <p>Nothing to buy.</p>
      ) : snapshot?.lines.length ? snapshot.lines.map((line) => <GameAppCard
        key={`${line.kind}:${line.identity}`}
        title={line.displayName}
        badge={`${line.offerGold} Gold`}
        action={<button type="button" disabled={busy} onClick={() => setPending({ action: "sell", line })}>
          {line.kind === "resource" ? "Sell Stack" : "Sell Item"}
        </button>}
      ><span>{line.kind === "resource" ? `Stack ×${line.quantity}` : line.kind === "equipment" ? "Equipment" : "Backpack"}</span></GameAppCard>) :
        <p>Nothing to sell.</p>}
    </GameAppShell>
    {pending ? <GameConfirmationPrompt
      title={pending.action === "buy" ? `Buy ${pending.line.displayName}?` : `Sell ${pending.line.displayName}?`}
      detail={pending.action === "buy"
        ? `${pending.line.unitPriceGold} Gold · Stock ×${pending.line.quantity}`
        : pending.line.kind === "resource"
          ? `Stack ×${pending.line.quantity} · ${pending.line.offerGold} Gold`
          : `${pending.line.offerGold} Gold`}
      confirmLabel={pending.action === "buy" ? "Buy" : "Sell"}
      busy={busy}
      onConfirm={() => {
        if (pending.action === "buy") onBuy(pending.line);
        else onSell(pending.line);
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    /> : null}
  </>;
}
