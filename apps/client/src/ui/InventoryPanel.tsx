import {
  DEFAULT_MANOR_TYPE_ID,
  EQUIPMENT_MAX_CONDITION,
  INVENTORY_CATALOG,
  UTILITY_GEAR,
  isUtilityGearDefinitionId,
  formatWeightKg,
  getItemWeightGrams,
  getBackpackWeightGrams,
  equipmentRepairCostForFamily,
  isEquipmentBroken,
  BROKEN_EQUIP_REASON,
  equipmentEffectDisplayName,
  equipmentMetalDisplayName,
  parseEquipmentEnhancement,
  requireEquipmentDefinition,
  requireBackpackLevel,
  MAX_BACKPACK_UPGRADE_LEVEL,
  type AchievementSnapshot,
  type BackpackInstanceSnapshot,
  type BackpackSnapshot,
  type EquipmentInstanceV2,
  type EquipmentSnapshotV2,
  type EquipmentUpgradeDisabledReason,
  type InventoryProtectionSnapshot,
  type MarketInteger,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import {
  groupBackpackInstances,
  INVENTORY_GROUP_COLLAPSE_OVER,
  inventoryDropSelection,
  inventoryItemGroup,
  inventoryPanelRows,
  type InventoryDropSelection
} from "../inventory/inventoryPanelModel.js";
import { formatMarketInteger } from "../market/marketFormat.js";
import { DestinationShell } from "./DestinationShell.js";
import { GameActionPrompt, GameConfirmationPrompt } from "./GameActionPrompt.js";
import {
  GameAppBackButton,
  GameAppButton,
  GameAppState,
  GameAppScrollRegion,
  GameAppTabs,
  GameAppText
} from "./GameAppShell.js";
import { InventoryCarrySummary, InventoryEntryRow, InventoryGroupRow, ProtectShieldGlyph } from "./InventoryCarryList.js";
import { InventoryItemActionDialog } from "./InventoryItemActionDialog.js";
import { InscriptionDetails } from "./InscriptionDetails.js";
import { ShopProvenanceDetails } from "./ShopProvenance.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { ItemRarityLabel } from "./ItemRarityLabel.js";
import { BrokenLabel } from "./BrokenLabel.js";
import { useInventoryFavorites } from "../inventory/inventoryFavorites.js";
import {
  isRoughRing,
  ringBonusPresentation,
  ringDumpShardCount,
  ringPolishLabel,
  ringTierName
} from "../inventory/ringPresentation.js";
import { RingBonusLines } from "./RingBonusLines.js";

type InventoryFilter = "all" | "equipment" | "resources" | "consumables" | "backpacks";

type Props = {
  open: boolean;
  inventory: PlayerInventorySnapshot;
  hasSnapshot: boolean;
  connectionStatus: "offline" | "connecting" | "online";
  droppingItemKey: string | null;
  equipment?: EquipmentSnapshotV2 | null;
  achievements?: AchievementSnapshot | null;
  backpacks?: BackpackSnapshot | null;
  goldBalance?: MarketInteger | null;
  /** Account Glimmer balance shown beside Gold (Lumen is read from inventory). */
  premiumBalances?: PremiumWalletSnapshot["balances"] | null;
  /** Opens the Glimmer shop; undefined while no purchase path is enabled. */
  onGetGlimmer?: () => void;
  equipmentBusy?: boolean;
  onEquip?(item: EquipmentInstanceV2): void;
  onUnequip?(item: EquipmentInstanceV2): void;
  onDropEquipment?(item: EquipmentInstanceV2): boolean;
  /** Legacy callbacks remain optional for old callers; backpack UI no longer invokes them. */
  onEquipBackpack?(item: BackpackInstanceSnapshot, targetSlot: number): void;
  onUnequipBackpack?(item: BackpackInstanceSnapshot): void;
  onUpgradeBackpack?(item: BackpackInstanceSnapshot): void;
  onOpenBackpacks?(): void;
  onUpgrade?(item: EquipmentInstanceV2): void;
  /** Random-roll rings: polish a Rough ring, or dump a ring for Ring Shards. */
  onPolishRing?(item: EquipmentInstanceV2): void;
  onDumpRing?(item: EquipmentInstanceV2): void;
  onChooseDrop(selection: InventoryDropSelection): void;
  onUseItem?(itemId: string, entryId: string): boolean;
  onPlantItem?(itemId: string): boolean;
  /** Manor skin equipped on the owner's Manor (its item stays here, locked), if any. */
  equippedManorSkin?: string | null;
  /** Manor skins: equip a skin on the owner's Manor; the default type unequips. */
  onEquipManorSkin?(manorTypeId: string, copyId?: string): boolean;
  /** Mask worn by the player (appearance id); its item stays here, locked. */
  equippedMask?: string | null | undefined;
  /** Wear a mask (appearance id) or take it off (null). */
  onEquipMask?(copyId: string | null): boolean;
  gearScrolls?: React.ComponentProps<typeof InventoryItemActionDialog>["gearScrolls"];
  onFishItem?(rodId: string): boolean;
  protection?: InventoryProtectionSnapshot | null;
  onOpenProtection?(): void;
  /** Opens the Crafting app (starter gathering tools are crafted there, anywhere). */
  onOpenCrafting?(): void;
  manorMode?: boolean;
  closeLabel?: string;
  layout?: "desktop" | "phone";
  phoneDetailInstanceId?: string | null;
  onOpenPhoneEquipmentDetail?(instanceId: string): void;
  onBackPhoneChild?(): void;
  onOpenLoadout?(): void;
  onOpenStats?(): void;
  onOpenKits?(): void;
  onClose(): void;
};

export function InventoryPanel({
  open, inventory, hasSnapshot, connectionStatus, equipment = null, achievements = null,
  backpacks = null, goldBalance = null, premiumBalances = null, onGetGlimmer, equipmentBusy = false, onEquip, onUnequip,
  onDropEquipment, onUpgrade, onPolishRing, onDumpRing, onUpgradeBackpack, onChooseDrop, onUseItem, onPlantItem, equippedManorSkin = null, onEquipManorSkin, equippedMask, onEquipMask, gearScrolls, onFishItem,
  protection = null, onOpenProtection, onOpenCrafting,
  manorMode = false, closeLabel = "Close Inventory", layout = "desktop",
  phoneDetailInstanceId, onOpenPhoneEquipmentDetail, onBackPhoneChild,
  onOpenLoadout, onOpenStats, onOpenKits, onClose
}: Props): React.JSX.Element | null {
  const { favorites, toggleFavorites, updateFavorites } = useInventoryFavorites(inventory.playerId);
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string | null>(null);
  const [selectedResourceKey, setSelectedResourceKey] = useState<string | null>(null);
  /** A long-press on a tagged copy opens its Details instead of the action list. */
  const [detailsOnOpen, setDetailsOnOpen] = useState(false);
  const [selectedBackpackId, setSelectedBackpackId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [dropEquipmentInstanceId, setDropEquipmentInstanceId] = useState<string | null>(null);
  const controlledPhoneDetail = layout === "phone" && phoneDetailInstanceId !== undefined;
  const resources = useMemo(() => inventoryPanelRows(inventory), [inventory]);
  const ownedEquipment = useMemo(() => equipment?.instances.filter(({ location }) =>
    location === "inventory" || location === "equipped") ?? [], [equipment]);
  const ownedBackpacks = useMemo(() => backpacks?.instances.filter(({ location }) => location !== "destroyed") ?? [], [backpacks]);
  const backpackGroups = useMemo(() => groupBackpackInstances(ownedBackpacks), [ownedBackpacks]);
  const entries = useMemo(() => [
    ...resources.map((item) => ({ kind: "resource" as const, key: item.key, name: item.name, item })),
    ...ownedEquipment.map((item) => ({ kind: "equipment" as const, key: item.instanceId, name: item.displayName, item })),
    ...backpackGroups.map((group) => ({
      kind: "backpack" as const,
      key: group.key,
      name: group.item.displayName,
      item: group.item,
      items: group.items,
      quantity: group.quantity
    }))
  ], [resources, ownedEquipment, backpackGroups]);
  const favoriteKeys = (entry: typeof entries[number]): string[] => entry.kind === "resource"
    ? [`resource:${entry.item.itemId}:${entry.item.variant ?? ""}`]
    : entry.kind === "backpack"
      ? entry.items.map((item) => `backpack:${item.instanceId}`)
      : [`equipment:${entry.item.instanceId}`];
  const hasFavorite = (entry: typeof entries[number]): boolean =>
    favoriteKeys(entry).some((key) => favorites.has(key));
  const isFullyFavorite = (entry: typeof entries[number]): boolean =>
    favoriteKeys(entry).every((key) => favorites.has(key));
  // "Pinned" is a client-local flag stored beside favourites as `pin:<favourite key>`.
  const pinKey = (entry: typeof entries[number]): string => `pin:${favoriteKeys(entry)[0]}`;
  const isPinned = (entry: typeof entries[number]): boolean => entry.kind === "resource" && favorites.has(pinKey(entry));
  entries.sort((left, right) => Number(hasFavorite(right)) - Number(hasFavorite(left)) || left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  const visibleEntries = entries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "equipment") return entry.kind === "equipment";
    if (filter === "backpacks") return entry.kind === "backpack";
    if (entry.kind !== "resource") return false;
    const consumable = INVENTORY_CATALOG[entry.item.itemId]?.kind === "consumable";
    return filter === "consumables" ? consumable : !consumable;
  });
  const groupStats = new Map<string, { name: string; kinds: number; quantity: number; weight: bigint }>();
  for (const entry of visibleEntries) {
    if (entry.kind !== "resource" || isPinned(entry)) continue;
    const group = inventoryItemGroup(entry.item.itemId);
    if (!group) continue;
    const stats = groupStats.get(group.id) ?? { name: group.name, kinds: 0, quantity: 0, weight: 0n };
    stats.kinds += 1;
    stats.quantity += entry.item.quantity;
    stats.weight += BigInt(entry.item.totalWeightGrams);
    groupStats.set(group.id, stats);
  }
  const groupFor = (entry: typeof entries[number]): string | null => {
    const id = entry.kind === "resource" && !isPinned(entry) ? inventoryItemGroup(entry.item.itemId)?.id ?? null : null;
    return id && (groupStats.get(id)?.kinds ?? 0) > INVENTORY_GROUP_COLLAPSE_OVER ? id : null;
  };
  // Order: (a) pinned rows and starred ungrouped items, (b) group rows A-Z with their members
  // directly beneath (starred members first), (c) the remaining items A-Z.
  const byName = (left: { name: string; key: string }, right: { name: string; key: string }): number =>
    left.name.localeCompare(right.name) || left.key.localeCompare(right.key);
  const topEntries: typeof visibleEntries = [];
  const restEntries: typeof visibleEntries = [];
  const membersByGroup = new Map<string, typeof visibleEntries>();
  for (const entry of visibleEntries) {
    const groupId = groupFor(entry);
    if (groupId) membersByGroup.set(groupId, [...(membersByGroup.get(groupId) ?? []), entry]);
    else if (isPinned(entry) || hasFavorite(entry)) topEntries.push(entry);
    else restEntries.push(entry);
  }
  // Search filters the current tab after grouping: a group-name match keeps the whole group,
  // otherwise only matching members stay, and an active search shows groups expanded.
  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  const matches = (entry: typeof visibleEntries[number]): boolean => entry.name.toLowerCase().includes(needle);
  const keepMember = (groupId: string, entry: typeof visibleEntries[number]): boolean =>
    !searching || groupStats.get(groupId)!.name.toLowerCase().includes(needle) || matches(entry);
  const isExpanded = (groupId: string): boolean => searching || expandedGroups.has(groupId);
  const searchFiltered = <T extends typeof visibleEntries[number]>(list: T[]): T[] => searching ? list.filter(matches) : list;
  const orderedEntries = [
    ...searchFiltered(topEntries).sort(byName),
    ...[...membersByGroup.entries()]
      .sort(([left], [right]) => groupStats.get(left)!.name.localeCompare(groupStats.get(right)!.name))
      .flatMap(([groupId, members]) => members.filter((entry) => keepMember(groupId, entry)).sort((left, right) => Number(hasFavorite(right)) - Number(hasFavorite(left)) || byName(left, right))),
    ...searchFiltered(restEntries).sort(byName)
  ];
  const groupHeaderShown = new Set<string>();
  const activeEquipmentId = controlledPhoneDetail ? phoneDetailInstanceId : selectedEquipmentId;
  const selectedEquipment = ownedEquipment.find(({ instanceId }) => instanceId === activeEquipmentId) ?? null;
  const selectedResource = resources.find(({ key }) => key === selectedResourceKey) ?? null;
  const online = connectionStatus === "online" && hasSnapshot;
  const selectedBackpack = ownedBackpacks.find(({ instanceId }) => instanceId === selectedBackpackId) ?? null;
  const selectedBackpackLevel = selectedBackpack?.upgradeLevel ?? 0;
  const selectedBackpackNext = selectedBackpack && selectedBackpackLevel < MAX_BACKPACK_UPGRADE_LEVEL
    ? requireBackpackLevel(selectedBackpackLevel + 1)
    : null;
  const selectedBackpackUpgradeReason = selectedBackpackNext
    ? !online
      ? "Reconnect before upgrading this backpack."
      : !onUpgradeBackpack
        ? "Backpack upgrades are unavailable."
        : (inventory.totals.leather < selectedBackpackNext.upgradeCost.leather
          ? `Requires ${selectedBackpackNext.upgradeCost.leather} leather.`
          : goldBalance === null || goldBalance === undefined
            ? "Gold balance is unavailable."
            : BigInt(goldBalance) < BigInt(selectedBackpackNext.upgradeCost.gold)
              ? `Requires ${selectedBackpackNext.upgradeCost.gold.toLocaleString()} gold.`
              : null)
    : null;
  const selectedResourceProtection = protection?.stackAllocations.find(({ stackId }) => stackId === selectedResource?.stackId) ?? null;
  const selectedResourceForActions = selectedResource ? {
    ...selectedResource,
    canDrop: selectedResource.canDrop && Boolean(protection) && (selectedResourceProtection?.movableQuantity ?? 0) > 0
  } : null;
  const hasInventorySections = false;

  useEffect(() => {
    if (!open || !hasSnapshot) {
      setSelectedEquipmentId(null);
      setSelectedResourceKey(null);
      setSelectedBackpackId(null);
      setDropEquipmentInstanceId(null);
    }
    if (!open) { setFilter("all"); setQuery(""); }
  }, [open, hasSnapshot]);
  useEffect(() => {
    if (selectedResourceKey && !selectedResource) setSelectedResourceKey(null);
  }, [selectedResource, selectedResourceKey]);
  const closeEquipmentDetail = (): void => {
    if (controlledPhoneDetail) {
      // The phone route passes `null` while Items is at its root. Category
      // tabs must only unwind the child route when a detail screen is open.
      if (phoneDetailInstanceId !== null) onBackPhoneChild?.();
      return;
    }
    setSelectedEquipmentId(null);
  };

  return <>
    <DestinationShell open={open} title="Inventory" menuId="equipment" closeLabel={closeLabel} layout={layout}
      headerAction={onOpenProtection || onOpenCrafting ? <div className="inventory-header-actions">
        {onOpenCrafting ? <GameAppButton type="button" className="inventory-header-action" onClick={onOpenCrafting} aria-label="Crafting">
          Craft
        </GameAppButton> : null}
        {onOpenProtection ? <GameAppButton type="button" className="inventory-header-action" onClick={onOpenProtection} aria-label="Item Protection">
          <ProtectShieldGlyph />Protect
        </GameAppButton> : null}
      </div> : undefined}
      className={`inventory-destination inventory-carry-destination${hasInventorySections ? " inventory-app-with-tabs" : ""}`}
      phoneBackLabel={selectedEquipment ? "Back to Inventory" : "Back to Game Menu"}
      onClose={selectedEquipment && layout === "phone" ? closeEquipmentDetail : onClose}
      >
      {hasInventorySections ? <div className="inventory-primary-navigation"><GameAppTabs variant="housed" ariaLabel="Inventory sections" activeTab="items"
        tabs={[{ id: "items", label: "Items" }, { id: "loadout", label: "Loadout" }, { id: "stats", label: "Stats" }, { id: "kits", label: "Kits" }]}
        onChange={(tab) => { if (tab === "loadout") onOpenLoadout?.(); else if (tab === "stats") onOpenStats?.(); else if (tab === "kits") onOpenKits?.(); }} /></div> : null}
      <div className="inventory-carry-layout">
        <header className="inventory-carry-header">
          <InventoryCarrySummary inventory={inventory} available={hasSnapshot}
            gold={goldBalance === null ? "Unavailable" : formatMarketInteger(goldBalance)}
            premiumBalances={premiumBalances}
            {...(onGetGlimmer ? { onGetGlimmer } : {})} />
          <GameAppTabs variant="subtabs" scrollable={layout === "phone"} ariaLabel="Inventory categories" activeTab={filter}
             tabs={[{ id: "all", label: "All" }, { id: "equipment", label: "Equipment" }, { id: "resources", label: "Resources" }, { id: "consumables", label: "Consumables" }, ...(ownedBackpacks.length > 0 ? [{ id: "backpacks" as const, label: "Backpacks" }] : [])]}
            onChange={(id) => { setFilter(id as InventoryFilter); closeEquipmentDetail(); }} />
          <div className="inventory-search" role="search">
            <input type="text" inputMode="search" enterKeyHint="search" autoComplete="off" spellCheck={false} className="inventory-search-input"
              aria-label="Search inventory" placeholder="Search items" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            {query ? <GameAppButton type="button" variant="quiet" className="game-app-button-compact" onClick={() => setQuery("")}>Clear</GameAppButton> : null}
          </div>
        </header>
        <GameAppScrollRegion className="inventory-carry-scroll" ariaLabel="Inventory items">
          {!hasSnapshot ? <GameAppState variant="loading" className="empty-state">
            {connectionStatus === "offline" ? "Inventory unavailable while disconnected." : "Loading inventory…"}
          </GameAppState> : <>
            {connectionStatus !== "online" ? <GameAppText as="p" tone="helper" className="inventory-status" role="status">{connectionStatus === "offline" ? "Offline" : "Reconnecting"}. Showing your last inventory.</GameAppText> : null}
            {orderedEntries.length === 0 ? <GameAppState className="empty-state">
              {searching ? "No items match." : filter === "all" ? "Your inventory is empty." : "No items in this category."}
            </GameAppState> : <ul className="inventory-carry-list" aria-label="Inventory items">
              {orderedEntries.flatMap((entry) => {
                const groupId = groupFor(entry);
                const groupHeader: React.JSX.Element[] = [];
                if (groupId) {
                  const stats = groupStats.get(groupId)!;
                  if (!groupHeaderShown.has(groupId)) {
                    groupHeaderShown.add(groupId);
                    groupHeader.push(<InventoryGroupRow key={`group:${groupId}`} groupId={groupId} name={stats.name} kinds={stats.kinds}
                      quantity={stats.quantity} weightGrams={stats.weight} expanded={isExpanded(groupId)}
                      onToggle={() => setExpandedGroups((current) => {
                        const next = new Set(current);
                        if (!next.delete(groupId)) next.add(groupId);
                        return next;
                      })} />);
                  }
                  if (!isExpanded(groupId)) return groupHeader;
                }
                const entryFavoriteKeys = favoriteKeys(entry);
                const pinned = isPinned(entry);
                // Members of a group (collapsing, or pinned out of one) get tap = favourite in group, long-press = pin.
                const pinnable = entry.kind === "resource" && inventoryItemGroup(entry.item.itemId) !== null && (Boolean(groupId) || pinned);
                const favoriteProps = {
                  favorite: isFullyFavorite(entry),
                  pinned,
                  onToggleFavorite: () => {
                    if (pinned) updateFavorites([], [pinKey(entry), ...entryFavoriteKeys]);
                    else toggleFavorites(entryFavoriteKeys);
                  },
                  ...(pinnable ? { onPin: () => { if (!pinned) updateFavorites([pinKey(entry)], entryFavoriteKeys); } } : {})
                };
                const row = ((): React.JSX.Element => {
                if (entry.kind === "resource") {
                  const item = entry.item;
                  return <InventoryEntryRow key={entry.key} {...favoriteProps} grouped={Boolean(groupId)} name={item.name} quantity={item.quantity}
                    weightGrams={item.totalWeightGrams} artwork={<ItemArtwork itemId={item.itemId} variant={item.look ?? item.variant} label={item.name} />}
                    {...(item.provenance ? { onHold: () => { setDetailsOnOpen(true); setSelectedResourceKey(item.key); } } : {})}
                    detail={item.itemId === "fishing_rod" ? `${item.usesRemaining ?? 0} / 100 uses remaining`
                      : isEquippedManorSkin(item, equippedManorSkin) || isWornMask(item, equippedMask) ? "Equipped" : undefined}
                    protectedItem={(protection?.stackAllocations.find(({ stackId }) => stackId === item.stackId)?.protectedQuantity ?? 0) > 0}
                    selected={selectedResourceKey === item.key} onSelect={() => { setDetailsOnOpen(false); setSelectedResourceKey(item.key); }} />;
                }
                if (entry.kind === "backpack") {
                  const item = entry.item;
                  const weightGrams = entry.items.reduce((total, backpack) =>
                    total + (backpack.unitWeightGrams ?? getBackpackWeightGrams()), 0);
                  return <InventoryEntryRow key={entry.key} {...favoriteProps} name={entry.name} quantity={entry.quantity} weightGrams={weightGrams}
                    detail={`+${formatWeightKg(item.capacityBonusGrams ?? item.capacityBonus ?? requireBackpackLevel(item.upgradeLevel ?? 0).capacityBonusGrams)} kg ${entry.quantity > 1 ? "each" : "capacity"} · Owned`}
                    artwork={<ItemArtwork itemId="pack" label={entry.name} />} rowVariant="backpack"
                    selected={entry.items.some(({ instanceId }) => selectedBackpackId === instanceId)} onSelect={() => setSelectedBackpackId(item.instanceId)} />;
                }
                const item = entry.item;
                const rowEnhancement = parseEquipmentEnhancement(item.enchantmentIdentity);
                const rowBroken = isEquipmentBroken(item);
                const detailText = [`Level ${item.itemLevel}`,
                  rowEnhancement?.gemstone ? categoryLabel(rowEnhancement.gemstone) : null,
                  item.location === "equipped" ? "Equipped" : null,
                  !rowBroken && item.condition !== null && item.condition !== undefined ? `${item.condition}% condition` : null].filter(Boolean).join(" · ");
                const detail = rowBroken ? <>{detailText} · <BrokenLabel /></> : detailText;
                const rowName = rowEnhancement?.metal
                  ? `${equipmentMetalDisplayName(rowEnhancement.metal)} ${item.displayName}`
                  : item.displayName;
                return <InventoryEntryRow key={entry.key} {...favoriteProps} name={rowName} quantity={1} weightGrams={getItemWeightGrams(item.definitionId)} detail={detail}
                  artwork={<ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />}
                  protectedItem={protection?.uniqueItems.find(({ equipmentInstanceId }) => equipmentInstanceId === item.instanceId)?.protected ?? false}
                  selected={activeEquipmentId === item.instanceId} onSelect={() => { if (controlledPhoneDetail) onOpenPhoneEquipmentDetail?.(item.instanceId); else setSelectedEquipmentId(item.instanceId); }} />;
                })();
                return [...groupHeader, row];
              })}
            </ul>}
          </>}
        </GameAppScrollRegion>
      </div>
    </DestinationShell>
    {open && selectedEquipment && !dropEquipmentInstanceId ? <EquipmentActionPrompt item={selectedEquipment} achievements={achievements}
      busy={equipmentBusy || !online} goldBalance={goldBalance} onEquip={onEquip} onUnequip={onUnequip} onUpgrade={onUpgrade}
      equipment={equipment} onPolishRing={onPolishRing} onDumpRing={onDumpRing}
      onRequestDrop={() => setDropEquipmentInstanceId(selectedEquipment.instanceId)}
      dropDisabledReason={equipmentDropDisabledReason(selectedEquipment, connectionStatus, hasSnapshot, protection)} onClose={closeEquipmentDetail} /> : null}
    {open && selectedResourceForActions ? <InventoryItemActionDialog key={`${selectedResourceForActions.key}:${detailsOnOpen}`} startInDetails={detailsOnOpen} item={selectedResourceForActions} online={online} manorMode={manorMode}
      gearScrolls={gearScrolls}
      {...(selectedResourceForActions.itemId === "fishing_rod" && selectedResourceForActions.rodId
        ? { onFish: () => Boolean(onFishItem?.(selectedResourceForActions.rodId!)) }
        : {})}
      onUse={() => Boolean(onUseItem?.(selectedResourceForActions.itemId, selectedResourceForActions.stackId))}
      {...(onPlantItem ? { onPlant: () => onPlantItem(selectedResourceForActions.itemId) } : {})}
      {...(onEquipManorSkin && selectedResourceForActions.itemId === "manor_skin" && selectedResourceForActions.variant
        ? {
            skinEquipped: isEquippedManorSkin(selectedResourceForActions, equippedManorSkin),
            onEquipSkin: () => onEquipManorSkin(selectedResourceForActions.look ?? selectedResourceForActions.variant!, selectedResourceForActions.variant!),
            onUnequipSkin: () => onEquipManorSkin(DEFAULT_MANOR_TYPE_ID)
          }
        : {})}
      {...(onEquipMask && selectedResourceForActions.itemId === "face_mask" && selectedResourceForActions.variant
        ? {
            skinEquipped: isWornMask(selectedResourceForActions, equippedMask),
            onEquipSkin: () => onEquipMask(selectedResourceForActions.variant!),
            onUnequipSkin: () => onEquipMask(null)
          }
        : {})}
      onDrop={() => { const selection = inventoryDropSelection(selectedResourceForActions); setSelectedResourceKey(null); if (selection) onChooseDrop(selection); }}
      dropDisabledReason={isEquippedManorSkin(selectedResourceForActions, equippedManorSkin) && selectedResourceForActions.quantity <= 1
        ? "Equipped on your Manor. Unequip it first."
        : isWornMask(selectedResourceForActions, equippedMask) && selectedResourceForActions.quantity <= 1
        ? "Worn right now. Take it off first."
        : !protection ? "Loading item protection…" : selectedResourceProtection?.movableQuantity === 0 ? selectedResourceProtection.reason : null}
      onClose={() => { setDetailsOnOpen(false); setSelectedResourceKey(null); }} /> : null}
    {open && selectedBackpack ? <GameActionPrompt title={`Backpack +${selectedBackpackLevel}`} category="BACKPACK"
      detail={`+${formatWeightKg(selectedBackpack.capacityBonusGrams ?? requireBackpackLevel(selectedBackpackLevel).capacityBonusGrams)} kg carrying capacity · 0 kg item weight · Owned`}
      artwork={<ItemArtwork itemId="pack" label={`Backpack +${selectedBackpackLevel}`} />} elevated
      actions={[
        ...(selectedBackpackNext ? [{ key: "upgrade", label: `Upgrade to +${selectedBackpackNext.level}`, enabled: !selectedBackpackUpgradeReason, disabledReason: selectedBackpackUpgradeReason,
          onSelect: () => { onUpgradeBackpack?.(selectedBackpack); setSelectedBackpackId(null); } }] : [])
      ]}
      message={selectedBackpackNext ? { text: `Next level: +${formatWeightKg(selectedBackpackNext.capacityBonusGrams)} kg capacity · ${selectedBackpackNext.upgradeCost.leather} Leather · ${selectedBackpackNext.upgradeCost.gold.toLocaleString()} Gold` } : { text: `Maximum upgrade +${MAX_BACKPACK_UPGRADE_LEVEL}.` }} onCancel={() => setSelectedBackpackId(null)} /> : null}
    {open && dropEquipmentInstanceId && equipment ? (() => {
      const item = equipment.instances.find(({ instanceId }) => instanceId === dropEquipmentInstanceId);
      if (!item) return null;
      const disabledReason = equipmentDropDisabledReason(item, connectionStatus, hasSnapshot, protection);
      return <GameConfirmationPrompt title={`Drop ${item.displayName}?`} category="DROP EQUIPMENT"
        detail="This item will be left on the ground." confirmLabel="Drop item" confirmEnabled={!disabledReason && Boolean(onDropEquipment)} busy={equipmentBusy}
        disabledReason={disabledReason} destructive onConfirm={() => { if (onDropEquipment?.(item)) { setDropEquipmentInstanceId(null); closeEquipmentDetail(); } }} onCancel={() => setDropEquipmentInstanceId(null)} />;
    })() : null}
  </>;
}

/** True for the inventory stack of the mask the player is wearing. */
function isWornMask(item: { itemId: string; variant?: string | null }, equippedMask: string | null | undefined): boolean {
  return item.itemId === "face_mask" && Boolean(item.variant) &&
    (equippedMask !== undefined ? item.variant === equippedMask : (item as { equipped?: boolean }).equipped === true);
}

/** True for the inventory stack of the skin equipped on the owner's Manor. */
function isEquippedManorSkin(item: { itemId: string; variant?: string | null }, equippedManorSkin: string | null): boolean {
  if (item.itemId !== "manor_skin" || !item.variant) return false;
  // Skins are per-copy items: the server marks the equipped copy.
  return (item as { equipped?: boolean }).equipped === true ||
    (item.variant === equippedManorSkin && equippedManorSkin !== DEFAULT_MANOR_TYPE_ID);
}

export function EquipmentActionPrompt({ item, achievements, busy, goldBalance, equipment = null, onEquip, onUnequip, onUpgrade, onPolishRing, onDumpRing, onRequestDrop, dropDisabledReason, onClose }: {
  item: EquipmentInstanceV2;
  achievements?: AchievementSnapshot | null;
  busy: boolean;
  goldBalance: MarketInteger | null;
  equipment?: EquipmentSnapshotV2 | null;
  onEquip?: Props["onEquip"];
  onUnequip?: Props["onUnequip"];
  onUpgrade?: Props["onUpgrade"];
  onPolishRing?: Props["onPolishRing"];
  onDumpRing?: Props["onDumpRing"];
  onRequestDrop(): void;
  dropDisabledReason?: string | null;
  onClose(): void;
}): React.JSX.Element {
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [confirmDump, setConfirmDump] = useState(false);
  if (item.ring) {
    const rough = isRoughRing(item);
    const shards = ringDumpShardCount(item) ?? 0;
    const tierName = ringTierName(item) ?? item.displayName;
    if (confirmDump) return <GameConfirmationPrompt title={`Dump ${tierName}?`} category="RING"
      detail={`The ring is destroyed for ${shards} Ring Shards. No Gold.`}
      confirmLabel="Dump" confirmEnabled={Boolean(onDumpRing) && item.location === "inventory"}
      disabledReason={item.location === "inventory" ? null : "Take the ring off first."} busy={busy} destructive
      onConfirm={() => { onDumpRing?.(item); onClose(); }} onCancel={() => setConfirmDump(false)} />;
    const bonuses = ringBonusPresentation(item, equipment);
    const actions = [
      ...(rough
        ? [{ key: "polish", label: ringPolishLabel(item) ?? "Polish", tone: "primary" as const,
            enabled: !busy && Boolean(onPolishRing), disabledReason: null,
            onSelect: () => { onPolishRing?.(item); onClose(); } }]
        : [{ key: "equip", label: item.location === "equipped" ? "Unequip" : "Equip", tone: "primary" as const,
            enabled: !busy && Boolean(item.location === "equipped" ? onUnequip : onEquip), disabledReason: null,
            onSelect: () => { if (item.location === "equipped") onUnequip?.(item); else onEquip?.(item); onClose(); } }]),
      // Popup standard: unusable actions are hidden (a worn ring is taken off before dumping).
      ...(item.location === "inventory" && onDumpRing ? [{ key: "dump", label: `Dump · ${shards} Shards`, tone: "danger" as const,
        enabled: !busy, disabledReason: null, onSelect: () => setConfirmDump(true) }] : []),
      ...(rough || item.location !== "inventory" ? [] : [{ key: "drop", label: "Drop", tone: "danger" as const, enabled: !busy && !dropDisabledReason,
        disabledReason: dropDisabledReason ?? null, onSelect: onRequestDrop }])
    ];
    return <GameActionPrompt title={item.displayName} category="Ring" elevated
      artwork={<span className={`ring-tier-frame ring-tier-${item.ring.tier}${rough ? " ring-rough" : ""}`}>
        <ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} /></span>}
      content={<RingBonusLines lines={bonuses} rough={rough} />}
      detail={`${tierName}${rough ? " · Rough" : ""}`}
      actions={actions} onCancel={onClose} />;
  }
  if (item.usesRemaining != null) {
    const spec = isUtilityGearDefinitionId(item.definitionId) ? UTILITY_GEAR[item.definitionId] : null;
    return <GameActionPrompt title={item.displayName} category={categoryLabel(item.derived.slot)} elevated
      artwork={<ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />}
      content={<><ItemRarityLabel rarity="rare" />{spec ? <GameAppText tone="helper">{spec.description}</GameAppText> : null}</>}
      detail={`${item.usesRemaining} ${item.usesRemaining === 1 ? "use" : "uses"} left`}
      actions={[
        { key: "equip", label: item.location === "equipped" ? "Unequip" : "Equip", tone: "primary",
          enabled: !busy && Boolean(item.location === "equipped" ? onUnequip : onEquip), disabledReason: null,
          onSelect: () => { if (item.location === "equipped") onUnequip?.(item); else onEquip?.(item); onClose(); } },
        ...(item.location !== "inventory" ? [] : [{ key: "drop", label: "Drop", tone: "danger" as const, enabled: !busy && !dropDisabledReason,
          disabledReason: dropDisabledReason ?? null, onSelect: onRequestDrop }])
      ]} onCancel={onClose} />;
  }
  const broken = isEquipmentBroken(item);
  const achievementMet = item.requiredAchievementId === "bitter_blood"
    ? achievements?.achievements.find(({ achievementId }) => achievementId === "bitter_blood")?.completed ?? item.achievementRequirementMet !== false
    : item.achievementRequirementMet !== false;
  const cost = item.nextUpgradeCost;
  const upgradeReason = item.nextUpgradeLevel === null || cost === null ? "Maximum upgrade reached."
    : goldBalance === null ? "Gold balance unavailable."
    : BigInt(goldBalance) < BigInt(cost) ? `Requires ${formatMarketInteger(cost)} Gold.` : null;
  if (confirmUpgrade) return <GameConfirmationPrompt title={`Upgrade ${item.displayName}?`} category="EQUIPMENT"
    detail={`+${item.itemLevel} → +${item.nextUpgradeLevel} · ${formatMarketInteger(cost ?? "0")} Gold`}
    confirmLabel="Upgrade" confirmEnabled={!upgradeReason && Boolean(onUpgrade)} disabledReason={upgradeReason} busy={busy}
    onConfirm={() => { onUpgrade?.(item); onClose(); }} onCancel={() => setConfirmUpgrade(false)} />;
  return <GameActionPrompt title={item.displayName} category={categoryLabel(item.derived.slot)} elevated
    artwork={<ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />}
    content={<><ItemRarityLabel rarity={INVENTORY_CATALOG[item.definitionId]?.rarity ?? "common"} />{broken ? <BrokenLabel /> : null}<InscriptionDetails inscription={item.inscription} />{item.provenance ? <ShopProvenanceDetails provenance={item.provenance} /> : null}{item.requiredAchievementId === "bitter_blood" ? <GameAppText tone="helper">{achievementMet ? "✓ Bitter Blood" : `Bitter Blood · ${achievements?.achievements.find(({ achievementId }) => achievementId === "bitter_blood")?.value ?? 0} / 250 poison damage taken`}</GameAppText> : null}</>}
    detail={`+${item.itemLevel} · ${item.derived.universalAttackContribution.toFixed(1)} Attack · ${item.derived.universalDefenseContribution.toFixed(1)} Defense${item.condition != null ? ` · ${item.condition}% condition` : ""}`}
    actions={[
      { key: "equip", label: item.location === "equipped" ? "Unequip" : "Equip", tone: "primary", keepVisible: broken,
        enabled: !busy && (item.location === "equipped" ? Boolean(onUnequip) : Boolean(onEquip) && !broken && achievementMet),
        disabledReason: broken ? BROKEN_EQUIP_REASON : !achievementMet ? "Bitter Blood achievement required." : null,
        onSelect: () => { if (item.location === "equipped") onUnequip?.(item); else onEquip?.(item); onClose(); } },
      { key: "upgrade", label: cost === null ? "Upgrade" : `Upgrade · ${formatMarketInteger(cost)} Gold`, enabled: !busy && !upgradeReason && Boolean(onUpgrade), disabledReason: upgradeReason, onSelect: () => setConfirmUpgrade(true) },
      { key: "drop", label: "Drop", tone: "danger", enabled: !busy && !dropDisabledReason, disabledReason: dropDisabledReason ?? null, onSelect: onRequestDrop }
    ]} onCancel={onClose} />;
}

export function EquipmentDetails({ item, achievements, busy, onEquip, onUnequip, onRequestDrop, dropDisabledReason, onClose }: {
  item: EquipmentInstanceV2;
  achievements?: AchievementSnapshot | null;
  characterLevel: number;
  busy: boolean;
  onEquip?: Props["onEquip"];
  onUnequip?: Props["onUnequip"];
  onRequestDrop?(): void;
  dropDisabledReason?: string | null;
  onClose(): void;
}): React.JSX.Element {
  const maximum = item.itemLevel === item.maximumItemLevel;
  const repairable = item.category === "chest_armor" &&
    equipmentRepairCostForFamily(requireEquipmentDefinition(item.definitionId).gameplayFamilyId) !== null;
  const condition = item.condition ?? EQUIPMENT_MAX_CONDITION;
  const enhancement = parseEquipmentEnhancement(item.enchantmentIdentity);
  const bitterBlood = achievements?.achievements.find(
    ({ achievementId }) => achievementId === "bitter_blood"
  );
  const achievementLegal = item.requiredAchievementId === "bitter_blood"
    ? bitterBlood?.completed ?? item.achievementRequirementMet !== false
    : item.achievementRequirementMet !== false;
  const broken = repairable && condition === 0;
  const equipLegal = achievementLegal && !broken;
  const disabledReason = broken
    ? "Repair this broken armor at a Manor Smithing Station before equipping it."
    : upgradeDisabledReasonLabel(item.upgradeDisabledReason);
  return <div className="inventory-detail-content">
    <GameAppBackButton className="inventory-detail-close" onClick={onClose} aria-label="Back to inventory" label="Back" />
    <ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />
    <div className="equipment-detail-heading">
      <span>{categoryLabel(item.category)}</span>
      <h3>{item.displayName}</h3>
      <strong>Level {item.itemLevel} · {item.location === "equipped" ? "Equipped" : "Inventory"}</strong>
      <ItemRarityLabel rarity={INVENTORY_CATALOG[item.definitionId]?.rarity ?? "common"} />
      {broken ? <BrokenLabel /> : null}
    </div>
    <dl className="equipment-detail-stats">
      <div><dt>Slot</dt><dd>{categoryLabel(item.derived.slot)}</dd></div>
      <div><dt>Attack</dt><dd>+{item.derived.universalAttackContribution.toFixed(1)}</dd></div>
      <div><dt>Defense</dt><dd>+{item.derived.universalDefenseContribution.toFixed(1)}</dd></div>
      {repairable ? <div className="equipment-detail-stat-wide">
        <dt>Condition</dt>
        <dd>{condition === 0
          ? "BROKEN - Repair required"
          : `${condition} / ${EQUIPMENT_MAX_CONDITION}`}</dd>
      </div> : null}
      {enhancement ? <div className="equipment-detail-stat-wide">
        <dt>Enhancement</dt>
        <dd>{enhancement.metal
          ? `${equipmentMetalDisplayName(enhancement.metal)} / ${equipmentEffectDisplayName(enhancement.effect ?? "poison")}${enhancement.gemstone ? ` · ${categoryLabel(enhancement.gemstone)} stone` : ""}`
          : `${categoryLabel(enhancement.gemstone ?? "none")} prepared`}</dd>
      </div> : null}
      {item.requiredAchievementId === "bitter_blood" ? <div className="equipment-detail-stat-wide">
        <dt>Equip Requirement</dt>
        <dd>{achievementLegal
          ? "✓ Bitter Blood"
          : `Bitter Blood · ${bitterBlood?.value ?? 0} / ${bitterBlood?.requiredValue ?? 250} poison damage taken`}</dd>
      </div> : null}
      <div className="equipment-detail-stat-wide"><dt>Utility</dt><dd>{equipmentUtilityLabel(item)}</dd></div>
      <div className="equipment-detail-stat-wide">
        <dt>Saved Combat Kits</dt>
        <dd>{item.savedKitIndices.length
          ? item.savedKitIndices.map((index) => `Kit ${index}`).join(", ")
          : "None"}</dd>
      </div>
    </dl>
    <div className="inventory-detail-actions">
      {item.location === "inventory" ? <GameAppButton type="button" disabled={busy || !onEquip || !equipLegal} onClick={() => onEquip?.(item)}>Equip</GameAppButton> : null}
      {item.location === "equipped" ? <GameAppButton type="button" disabled={busy || !onUnequip} onClick={() => onUnequip?.(item)}>Unequip</GameAppButton> : null}
      {item.location === "inventory" ? <GameAppButton type="button" variant="destructive" disabled={busy || Boolean(dropDisabledReason) || !onRequestDrop} title={dropDisabledReason ?? undefined} onClick={onRequestDrop}>Drop</GameAppButton> : null}
      <GameAppText as="p" tone="helper" className="equipment-upgrade-note">
        {maximum
          ? "Maximum Level"
          : "Upgrade carried equipment from Inventory."}
      </GameAppText>
    </div>
    {disabledReason ? <GameAppText as="small" tone="helper" className="equipment-upgrade-note">{disabledReason}</GameAppText> : null}
    {!achievementLegal ? <GameAppText as="small" tone="helper" className="equipment-upgrade-note">Bitter Blood is required to equip this item.</GameAppText> : null}
  </div>;
}

function equipmentDropDisabledReason(
  item: EquipmentInstanceV2,
  connectionStatus: Props["connectionStatus"],
  hasSnapshot: boolean,
  protection: InventoryProtectionSnapshot | null
): string | null {
  if (connectionStatus !== "online" || !hasSnapshot) return "Connect to drop equipment.";
  if (item.location !== "inventory") return "Unequip this item before dropping it.";
  if (isRoughRing(item)) return "Polish this ring before dropping it.";
  if (item.savedKitIndices.length > 0) return "Remove this item from saved combat kits first.";
  if (!protection) return "Loading authoritative item protection…";
  if (protection.uniqueItems.find(({ equipmentInstanceId }) =>
    equipmentInstanceId === item.instanceId
  )?.protected) return "Unprotect this item before dropping it.";
  return null;
}

function categoryLabel(category: string): string {
  return category.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function upgradeDisabledReasonLabel(reason: EquipmentUpgradeDisabledReason | null): string | null {
  switch (reason) {
    case "maximum_level": return "Maximum Level";
    case "destroyed": return "Destroyed equipment cannot be upgraded.";
    case "not_owned": return "Only owned equipment can be upgraded.";
    case "character_level_required": return "Raise your character level before the next upgrade.";
    case null: return null;
  }
}

export function equipmentUtilityLabel(item: EquipmentInstanceV2): string {
  switch (item.derived.utilityKind) {
    case "resource_maximum":
      return `+${item.derived.resourceMaximumBonus} maximum class resource`;
    case "resource_generation":
      return `${Math.round((item.derived.resourceGenerationMultiplier - 1) * 100)}% faster class-resource generation`;
    case "action_duration":
      return `${Math.round((1 - item.derived.actionDurationMultiplier) * 100)}% shorter gathering actions`;
    case "movement_and_cc":
      return `${Math.round((item.derived.movementSpeedMultiplier - 1) * 100)}% movement, ${Math.round((1 - item.derived.crowdControlDurationMultiplier) * 100)}% shorter crowd control`;
    case "chopping_duration":
      return `${Math.round((1 - item.derived.choppingDurationMultiplier) * 100)}% shorter chopping time`;
    case "mining_duration":
      return `${Math.round((1 - item.derived.miningDurationMultiplier) * 100)}% shorter mining time`;
    case "attack_bonus":
      return `+${item.derived.universalAttackContribution} attack`;
    case "none":
      return "No generic stat contribution";
  }
}
