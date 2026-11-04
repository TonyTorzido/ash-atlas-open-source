import type { CombatEntitySnapshot, HollinHutShopSnapshot } from "@ash-atlas/shared";

import { GameActionPrompt, type GamePromptPresentationState } from "./GameActionPrompt.js";
import { GameAppCard, GameAppShell } from "./GameAppShell.js";

export function isHollinHutTarget(target: CombatEntitySnapshot | null | undefined): boolean {
  return target?.kind === "mob" && target.archetypeKey === "hollin_hut" && target.lifeState === "alive";
}

/** Tap prompt for a Hollin Hut: trade with the Hollins, or raid the hut. */
export function HollinHutPrompt({
  target,
  presentationState,
  actionsReady = true,
  onTrade,
  onAttack,
  onClose
}: Readonly<{
  target: CombatEntitySnapshot;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  onTrade(): void;
  onAttack(): void;
  onClose(): void;
}>): React.JSX.Element {
  return <GameActionPrompt
    title={target.name}
    category="HOLLINS"
    ariaLabel={`${target.name} actions`}
    presentationState={presentationState}
    actionsReady={actionsReady}
    content={<p>{target.currentHealth} / {target.maxHealth} health</p>}
    actions={[
      { key: "trade", label: "Trade", onSelect: onTrade },
      { key: "attack", label: "Attack", onSelect: onAttack }
    ]}
    cancelLabel="Cancel"
    onCancel={onClose}
  />;
}

export function HollinHutPanel({
  open,
  snapshot,
  busy,
  layout,
  onBuy,
  onPacify,
  onService,
  onClose
}: Readonly<{
  open: boolean;
  snapshot: HollinHutShopSnapshot | null;
  busy: boolean;
  layout: "desktop" | "phone";
  onBuy(itemId: string, quantity: number, unitPriceGold: string): void;
  onPacify(): void;
  onService(service: "heal" | "turn_in_eggs"): void;
  onClose(): void;
}>): React.JSX.Element | null {
  if (!open) return null;
  const banned = snapshot?.tradeBannedUntil ?? null;
  return <GameAppShell open title="Hollin Hut" closeLabel="Close Hollin Hut" layout={layout} onClose={onClose}>
    {snapshot ? <p>
      {snapshot.walletGold} Gold
      {snapshot.discountPercent > 0 ? ` · Hollin Lore ${snapshot.rank}: ${snapshot.discountPercent}% off` : ""}
    </p> : <p>The Hollins are looking over their stock...</p>}
    {banned ? <GameAppCard
      title="The Hollins refuse to trade with you"
      badge={snapshot?.banReason === "raid" ? "Raided" : "Orchard theft"}
      action={snapshot?.canPacify
        ? <button type="button" disabled={busy} onClick={onPacify}>Offer a berry</button>
        : undefined}
    ><span>Until {new Date(banned).toLocaleString()}</span></GameAppCard> : <>
      {snapshot ? <GameAppCard
        title="Tend wounds"
        badge={`${snapshot.heal.costGold} Gold`}
        action={<button type="button" disabled={busy || !snapshot.heal.canHeal} onClick={() => onService("heal")}>Heal</button>}
      ><span>{snapshot.heal.canHeal
        ? `Health ${snapshot.heal.currentHealth} / ${snapshot.heal.maxHealth}`
        : "You are not hurt."}</span></GameAppCard> : null}
      {snapshot && !snapshot.eggs.discovered ? <GameAppCard
        title="Hollin Lore"
        badge={`${snapshot.eggs.have} / ${snapshot.eggs.need} Giant Eggs`}
        action={<button
          type="button"
          disabled={busy || snapshot.eggs.have < snapshot.eggs.need}
          onClick={() => onService("turn_in_eggs")}
        >Hand in eggs</button>}
      ><span>Offer {snapshot.eggs.need} Giant Eggs to learn the ways of the Hollins.</span></GameAppCard> : null}
      {snapshot ? <p>Stock changes {new Date(snapshot.stockRefreshesAt).toLocaleString()}</p> : null}
      {snapshot?.lines.map((line) => <GameAppCard
      key={line.itemId}
      title={line.displayName}
      badge={line.unitPriceGold === line.baseUnitPriceGold
        ? `${line.unitPriceGold} Gold each`
        : `${line.unitPriceGold} Gold each (was ${line.baseUnitPriceGold})`}
      action={<span>
        <button type="button" disabled={busy} onClick={() => onBuy(line.itemId, 1, line.unitPriceGold)}>Buy 1</button>
        {" "}
        <button type="button" disabled={busy} onClick={() => onBuy(line.itemId, 5, line.unitPriceGold)}>Buy 5</button>
      </span>}
    ><span>Up to {line.maxQuantity} at a time</span></GameAppCard>)}
    </>}
  </GameAppShell>;
}
