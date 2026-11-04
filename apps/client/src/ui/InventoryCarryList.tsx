import {
  formatWeightKg,
  PREMIUM_CURRENCIES,
  PREMIUM_CURRENCY_NAMES,
  type InventoryItemGroupId,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";
import { Fragment, useRef, type ReactNode } from "react";

import groupMeat from "../assets/items/groups/group-meat.png";
import groupHides from "../assets/items/groups/group-hides-pelts.png";
import groupFeathers from "../assets/items/groups/group-feathers.png";
import groupBars from "../assets/items/groups/group-bars-cores.png";
import groupOres from "../assets/items/groups/group-gems-minerals.png";
import groupFood from "../assets/items/groups/group-food.png";
import groupBones from "../assets/items/groups/group-bones-horns-teeth.png";
import groupScales from "../assets/items/groups/group-scales-shells-chitin.png";
import groupVenoms from "../assets/items/groups/group-venoms-glands.png";
import groupEssences from "../assets/items/groups/group-essences-cores.png";
import groupPlants from "../assets/items/groups/group-plants-fungi.png";
import groupTrinkets from "../assets/items/groups/group-cloth-gear-trinkets.png";
import groupTrophies from "../assets/items/groups/group-trophies.png";
import groupEggs from "../assets/items/groups/group-eggs.png";
import groupFish from "../assets/items/groups/group-fish-seafood.png";
import { ProtectionLockIcon } from "./ProtectionLockIcon.js";
import { GameAppButton } from "./GameAppShell.js";

export function StorageWeightSummary({
  currentWeightGrams,
  maximumWeightGrams,
  available = true
}: {
  currentWeightGrams?: string | undefined;
  maximumWeightGrams?: string | undefined;
  available?: boolean;
}): React.JSX.Element {
  const current = BigInt(currentWeightGrams ?? "0");
  const maximum = BigInt(maximumWeightGrams ?? "0");
  const known = available && maximum > 0n;
  const percent = known ? Math.min(100, Number(current * 10000n / maximum) / 100) : 0;
  return <div className="inventory-carry-summary" aria-label="Storage weight">
    <dl className="game-app-stats">
      <dt>Storage weight</dt>
      <dd>{known ? <>{formatWeightKg(current)} <small>/ {formatWeightKg(maximum)} kg</small></> : "Loading…"}</dd>
    </dl>
    {known ? <div className={`inventory-carry-track${current >= maximum ? " at-capacity" : ""}`}
      role="progressbar" aria-label="Storage capacity" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent} aria-valuetext={`${formatWeightKg(current)} of ${formatWeightKg(maximum)} kg`}>
      <span style={{ width: `${percent}%` }} />
    </div> : null}
  </div>;
}

export type CurrencyKind = "gold" | "glimmer" | "lumen";

export function InventoryCarrySummary({ inventory, available = true, gold, premiumBalances, onGetGlimmer }: {
  inventory: PlayerInventorySnapshot;
  available?: boolean;
  /** Optional Gold value; when given, the card shows the currency chip row. */
  gold?: ReactNode;
  /** Glimmer chip beside Gold; null while the balance is loading. Lumen is a carried item, listed with the rest. */
  premiumBalances?: PremiumWalletSnapshot["balances"] | null;
  /** Adds a "Get Glimmer" action to the Glimmer chip; omitted while no purchase path is enabled. */
  onGetGlimmer?: () => void;
}): React.JSX.Element {
  const current = BigInt(inventory.currentWeightGrams ?? "0");
  const maximum = BigInt(inventory.maximumWeightGrams ?? "0");
  const known = available && maximum > 0n;
  const percent = known ? Math.min(100, Number(current * 10000n / maximum) / 100) : 0;
  return <div className="inventory-carry-summary" aria-label="Inventory weight">
    <div className="inventory-carry-weight">
      <dl className="game-app-stats">
        <dt>Carry weight</dt>
        <dd>{known ? <>{formatWeightKg(current)} <small>/ {formatWeightKg(maximum)} kg</small></> : "Loading…"}</dd>
      </dl>
      {known ? <div className={`inventory-carry-track${current >= maximum ? " at-capacity" : ""}`}
        role="progressbar" aria-label="Carrying capacity" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent} aria-valuetext={`${formatWeightKg(current)} of ${formatWeightKg(maximum)} kg`}>
        <span style={{ width: `${percent}%` }} />
      </div> : null}
    </div>
    {gold !== undefined ? <ul className="inventory-currency-chips" aria-label="Currencies">
      <CurrencyChip kind="gold" name="Gold" value={gold} />
      {PREMIUM_CURRENCIES.map((currency) => {
        const balance = premiumBalances?.[currency].balance;
        return <CurrencyChip
          key={currency}
          kind={currency}
          name={PREMIUM_CURRENCY_NAMES[currency]}
          value={balance === undefined ? "Unavailable" : BigInt(balance).toLocaleString()}
          {...(currency === "glimmer" && onGetGlimmer ? { action: onGetGlimmer } : {})}
        />;
      })}
    </ul> : null}
  </div>;
}

function CurrencyChip({ kind, name, value, action }: {
  kind: CurrencyKind;
  name: string;
  value: ReactNode;
  action?: () => void;
}): React.JSX.Element {
  return <li className={`inventory-currency-chip inventory-currency-chip-${kind}`}>
    <CurrencyGlyph kind={kind} />
    <span className="inventory-currency-chip-text"><strong>{typeof value === "string" ? withGroupBreaks(value) : value}</strong> <span>{name}</span></span>
    {action ? <button type="button" className="inventory-currency-chip-action" onClick={action}>Get Glimmer</button> : null}
  </li>;
}

/** Lets a long grouped number wrap after its commas, keeping digit groups whole. */
function withGroupBreaks(value: string): ReactNode {
  const groups = value.split(",");
  return groups.map((group, index) => <Fragment key={index}>{group}{index < groups.length - 1 ? <>,<wbr /></> : null}</Fragment>);
}

/** Matching 16px currency marks: gold coin, Glimmer spark, Lumen gem. */
export function CurrencyGlyph({ kind }: { kind: CurrencyKind }): React.JSX.Element {
  return <svg className={`currency-glyph currency-glyph-${kind}`} viewBox="0 0 16 16" aria-hidden="true">
    {kind === "gold" ? <>
      <circle cx="8" cy="8" r="6.25" />
      <circle className="currency-glyph-detail" cx="8" cy="8" r="3.5" />
    </> : kind === "glimmer" ? <>
      <path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" />
    </> : <>
      <path d="M8 1.75 13.25 8 8 14.25 2.75 8Z" />
      <path className="currency-glyph-detail" d="M2.75 8h10.5M8 1.75v12.5" />
    </>}
  </svg>;
}

/** Shield mark for the compact Protect header action. */
export function ProtectShieldGlyph(): React.JSX.Element {
  return <svg className="inventory-header-action-glyph" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 2.5 16 4.75v4.5c0 4-2.6 6.9-6 8.25-3.4-1.35-6-4.25-6-8.25v-4.5Z" />
    <path d="M7.25 10.1 9.2 12l3.7-3.9" />
  </svg>;
}

/** Generic category art per group id (UI art only, not inventory items). */
// Ores and minerals and the reserved Gems and minerals group share one icon.
const GROUP_ART: Readonly<Record<InventoryItemGroupId, string>> = {
  meat: groupMeat, hides: groupHides, feathers: groupFeathers, bars: groupBars, ores: groupOres, food: groupFood,
  bones: groupBones, scales: groupScales, venoms: groupVenoms, essences: groupEssences, gems: groupOres,
  plants: groupPlants, trinkets: groupTrinkets, trophies: groupTrophies, eggs: groupEggs, fish: groupFish
};

const STAR_LONG_PRESS_MS = 500;

/** Star button: tap toggles; a long press (mouse or touch) pins instead and swallows the tap. */
function FavoriteStar({ name, favorite, pinned, onToggle, onPin }: {
  name: string; favorite: boolean; pinned: boolean; onToggle(): void; onPin?(): void;
}): React.JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const cancel = (): void => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const label = pinned ? `Unpin ${name}` : `${favorite ? "Unfavorite" : "Favorite"} ${name}`;
  return <GameAppButton variant="quiet" className={`inventory-favorite game-app-button-compact${pinned ? " inventory-favorite-pinned" : ""}`}
    aria-label={label} aria-pressed={favorite || pinned}
    {...(onPin ? { title: pinned ? "Pinned to top. Tap to unpin." : "Tap: favorite in group. Hold: pin to top." } : {})}
    onPointerDown={() => {
      longPressed.current = false;
      if (!onPin || pinned) return;
      cancel();
      timer.current = setTimeout(() => { timer.current = null; longPressed.current = true; onPin(); }, STAR_LONG_PRESS_MS);
    }}
    onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
    {...(onPin ? { onContextMenu: (event: React.MouseEvent) => event.preventDefault() } : {})}
    onClick={() => { if (longPressed.current) { longPressed.current = false; return; } onToggle(); }}>
    {favorite || pinned ? "★" : "☆"}{pinned ? <span className="inventory-favorite-pin" aria-hidden="true" /> : null}
  </GameAppButton>;
}

export function InventoryGroupRow({ groupId, name, kinds, quantity, weightGrams, expanded, onToggle }: {
  groupId: string;
  name: string;
  kinds: number;
  quantity: number;
  weightGrams: string | number | bigint;
  expanded: boolean;
  onToggle(): void;
}): React.JSX.Element {
  return <li className="inventory-entry inventory-entry-group">
    <GameAppButton type="button" className="inventory-entry-row inventory-group-row" aria-expanded={expanded}
      aria-label={`${name}, ${kinds} kinds, quantity ${quantity.toLocaleString()}, ${formatWeightKg(weightGrams)} kg`} onClick={onToggle}>
      <img className="item-artwork" src={GROUP_ART[groupId as InventoryItemGroupId]} alt="" aria-hidden="true" />
      <span className="inventory-entry-copy"><strong>{name}</strong>
        <small><span className="inventory-group-pill">{kinds} kinds</span> <span className="inventory-entry-quantity">×{quantity.toLocaleString()}</span></small>
      </span>
      <span className="inventory-entry-weight">{formatWeightKg(weightGrams)}<small> kg</small></span>
      <span className={`inventory-group-chevron${expanded ? " expanded" : ""}`} aria-hidden="true">›</span>
    </GameAppButton>
  </li>;
}

export function InventoryEntryRow({ name, artwork, quantity, weightGrams, detail, protectedItem = false, favorite = false, pinned = false, onToggleFavorite, onPin, selected = false, disabled = false, interactive = true, rowVariant = "default", grouped = false, onHold, onSelect }: {
  name: string;
  artwork: ReactNode;
  quantity: number;
  weightGrams: string | number | bigint;
  detail?: ReactNode;
  protectedItem?: boolean;
  favorite?: boolean;
  /** Pinned to the top of everything, out of its group (client-local). */
  pinned?: boolean;
  onToggleFavorite?(): void;
  /** Long-press on the star; only offered for items that belong to a group. */
  onPin?(): void;
  selected?: boolean;
  disabled?: boolean;
  interactive?: boolean;
  rowVariant?: "default" | "backpack";
  /** Member row shown under an expanded group row. */
  grouped?: boolean;
  /** Long-press (or right-click) on the row; used for the Details of a tagged copy. */
  onHold?(): void;
  onSelect(): void;
}): React.JSX.Element {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const cancelHold = (): void => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };
  const label = `${name}, quantity ${quantity.toLocaleString()}, ${formatWeightKg(weightGrams)} kg`;
  const backpackRow = rowVariant === "backpack";
  const content = <>
      {artwork}
      <span className="inventory-entry-copy"><strong>{name}</strong>
        <small><span className="inventory-entry-quantity">×{quantity.toLocaleString()}</span>{detail ? <> · {detail}</> : null}{protectedItem ? <span className="inventory-entry-protection" aria-label="Protected"><ProtectionLockIcon /></span> : null}</small>
      </span>
      <span className="inventory-entry-weight">{formatWeightKg(weightGrams)}<small> kg</small></span>
      <span className="inventory-entry-chevron" aria-hidden="true">›</span>
    </>;
  return <li className={`inventory-entry${onToggleFavorite ? " inventory-entry-with-favorite" : ""}${backpackRow ? " inventory-entry-backpack" : ""}${grouped ? " inventory-entry-grouped" : ""}`} {...(!interactive ? { role: "listitem", "aria-label": label } : {})}>
    {interactive ? <GameAppButton type="button" className={`inventory-entry-row${selected ? " selected" : ""}${backpackRow ? " inventory-entry-row--backpack" : ""}`}
      aria-label={label} aria-pressed={selected} disabled={disabled}
      {...(onHold ? {
        onPointerDown: () => { held.current = false; cancelHold(); holdTimer.current = setTimeout(() => { holdTimer.current = null; held.current = true; onHold(); }, STAR_LONG_PRESS_MS); },
        onPointerUp: cancelHold, onPointerLeave: cancelHold, onPointerCancel: cancelHold,
        onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); cancelHold(); held.current = false; onHold(); }
      } : {})}
      onClick={() => { if (held.current) { held.current = false; return; } onSelect(); }}>{content}</GameAppButton> :
      <div className={`inventory-entry-row${backpackRow ? " inventory-entry-row--backpack" : ""}`} aria-hidden="true">{content}</div>}
    {onToggleFavorite ? <FavoriteStar name={name} favorite={favorite} pinned={pinned} onToggle={onToggleFavorite} {...(onPin ? { onPin } : {})} /> : null}
  </li>;
}
