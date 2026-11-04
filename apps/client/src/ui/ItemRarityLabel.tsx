import type { ItemRarity } from "@ash-atlas/shared";

export function ItemRarityLabel({ rarity }: { rarity: ItemRarity }): React.JSX.Element {
  return (
    <span className="item-rarity-label" data-rarity={rarity}>
      {rarity[0]!.toUpperCase() + rarity.slice(1)}
    </span>
  );
}
