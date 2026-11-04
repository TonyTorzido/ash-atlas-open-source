import {
  MAX_BACKPACK_UPGRADE_LEVEL,
  formatWeightKg,
  requireBackpackLevel,
  type BackpackInstanceSnapshot,
  type BackpackSnapshot,
  type MarketInteger,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import { DestinationShell } from "./DestinationShell.js";
import {
  GameAppActionBar,
  GameAppButton,
  GameAppCard,
  GameAppState,
  GameAppText
} from "./GameAppShell.js";
import { InventoryCarrySummary } from "./InventoryCarryList.js";
import { ItemArtwork } from "./ItemArtwork.js";

type Props = {
  open: boolean;
  backpacks: BackpackSnapshot | null;
  inventory: PlayerInventorySnapshot;
  goldBalance: MarketInteger | null;
  online: boolean;
  pending: boolean;
  feedback: string | null;
  layout?: "desktop" | "phone";
  onCreate?(slot: number): void;
  /** Deprecated compatibility callbacks; backpack instances no longer move between slots. */
  onEquip?(instanceId: string, slot: number): void;
  onUnequip?(instanceId: string): void;
  onUpgrade(instanceId: string): void;
  onClose(): void;
};

/**
 * Backpacks are a persistent owned collection. Their capacity is cumulative
 * across carried inventory, legacy equipped rows, and manor storage, so this
 * screen deliberately has no equip/unequip controls or four-slot gate.
 */
export function BackpackPanel({
  open,
  backpacks,
  inventory,
  goldBalance,
  online,
  pending,
  feedback,
  layout = "desktop",
  onUpgrade,
  onClose
}: Props): React.JSX.Element | null {
  const instances = backpacks?.instances.filter(({ location }) => location !== "destroyed") ?? [];
  const commonReason = !online
    ? "Reconnect to change backpacks."
    : pending
      ? "A backpack action is in progress."
      : !backpacks
        ? "Loading backpacks…"
        : null;
  const gold = goldBalance === null ? null : BigInt(goldBalance);
  const costReason = (cost: { leather: number; gold: number }): string | null => inventory.totals.leather < cost.leather
    ? `Requires ${cost.leather} leather.`
    : gold === null
      ? "Gold balance is unavailable."
      : gold < BigInt(cost.gold)
        ? `Requires ${cost.gold} gold.`
        : null;

  const card = (item: BackpackInstanceSnapshot): React.JSX.Element => {
    const level = item.upgradeLevel ?? 0;
    const current = requireBackpackLevel(level);
    const next = level < MAX_BACKPACK_UPGRADE_LEVEL ? requireBackpackLevel(level + 1) : null;
    const upgradeReason = commonReason ?? (next ? costReason(next.upgradeCost) : null);
    return <GameAppCard
      key={item.instanceId}
      title={`Backpack +${level}`}
      badge="Owned"
      leading={<ItemArtwork itemId="pack" label={`Backpack +${level}`} />}
      status={`+${formatWeightKg(item.capacityBonusGrams ?? current.capacityBonusGrams)} kg capacity`}
      action={next ? <GameAppActionBar>
        <GameAppButton
          type="button"
          variant="primary"
          disabled={Boolean(upgradeReason)}
          title={upgradeReason ?? undefined}
          onClick={() => onUpgrade(item.instanceId)}
        >Upgrade to +{next.level}</GameAppButton>
      </GameAppActionBar> : undefined}
    >
      {next
        ? <GameAppText tone="helper" className="backpack-next-upgrade">
          Next: +{formatWeightKg(next.capacityBonusGrams - current.capacityBonusGrams)} kg · {next.upgradeCost.leather} leather · {next.upgradeCost.gold.toLocaleString()} gold
        </GameAppText>
        : <GameAppText tone="helper" className="backpack-next-upgrade">Maximum upgrade +{MAX_BACKPACK_UPGRADE_LEVEL}</GameAppText>}
    </GameAppCard>;
  };

  return <DestinationShell
    open={open}
    title="Backpacks"
    closeLabel="Back to Inventory"
    layout={layout}
    phoneBackLabel="Back to Inventory"
    className="backpack-destination"
    closeDisabled={pending}
    onClose={onClose}
  >
    <div className="backpack-capacity-header">
      <InventoryCarrySummary inventory={inventory} available={Boolean(backpacks)} />
      <GameAppText tone="helper" className="backpack-capacity-note">
        Every owned backpack adds capacity, including backpacks stored in your manor. There is no backpack equip limit.
      </GameAppText>
    </div>
    {feedback ? <GameAppText className="backpack-feedback" tone="helper" role="status">{feedback}</GameAppText> : null}
    {!backpacks ? <GameAppState variant="loading" className="empty-state">Loading backpacks…</GameAppState> : instances.length === 0
      ? <GameAppState className="empty-state">No backpacks owned. Craft a Backpack +0 from the Crafting menu.</GameAppState>
      : <section className="game-app-card-grid backpack-progression-cards" aria-label="Owned backpacks">{instances.map(card)}</section>}
  </DestinationShell>;
}
