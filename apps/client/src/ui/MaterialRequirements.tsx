import { itemArtworkSource, itemArtworkStyle } from "./ItemArtwork.js";
import { useItemNameTooltip } from "./ItemNameTooltip.js";

export type MaterialChipState = "met" | "short" | "unknown";

export function materialChipState(need: number, have: number | null | undefined): MaterialChipState {
  if (have === null || have === undefined) return "unknown";
  return have >= need ? "met" : "short";
}

export function materialChipLabel(name: string, need: number, have: number | null | undefined): string {
  if (have === null || have === undefined) return `${name} ${need.toLocaleString()}`;
  return have >= need
    ? `${name} ${need.toLocaleString()}, have ${have.toLocaleString()}`
    : `${name} ${need.toLocaleString()}, have ${have.toLocaleString()}, missing ${(need - have).toLocaleString()}`;
}

/** One material: its PNG and count, success tone when the player has enough and error tone when not. */
export function MaterialChip({ itemId, name, need, have, variant }: { itemId: string; name: string; need: number; have?: number | null | undefined; variant?: string | undefined }): React.JSX.Element {
  const state = materialChipState(need, have);
  const { bind, tip } = useItemNameTooltip(name);
  return <>
    <span className="phone-build-material-requirement material-chip" data-state={state} role="img" tabIndex={0} aria-label={materialChipLabel(name, need, have)} {...bind}>
      <img className="phone-build-material-artwork item-artwork" style={itemArtworkStyle(itemId, variant)} src={itemArtworkSource(itemId, null, variant)} alt="" aria-hidden="true" />
      <b>{state === "short" ? `${(have ?? 0).toLocaleString()}/${need.toLocaleString()}` : need.toLocaleString()}</b>
    </span>
    {tip}
  </>;
}

export type MaterialNeed = { itemId: string; quantity: number; name: string; have?: number | bigint | null | undefined; variant?: string | undefined };

/** A wrapping row of material chips; used by every station, profession and build panel. */
export function MaterialChips({ label, materials }: { label: string; materials: readonly MaterialNeed[] }): React.JSX.Element {
  return <div className="material-chip-list" role="group" aria-label={label}>
    {materials.map((material) => <MaterialChip
      key={`${material.itemId}:${material.variant ?? ""}:${material.name}`}
      itemId={material.itemId}
      name={material.name}
      need={material.quantity}
      have={material.have === null || material.have === undefined ? material.have : Number(material.have)}
      variant={material.variant}
    />)}
  </div>;
}

/**
 * Check mark (success tone) when the item can be built or crafted, X (error tone) when it cannot. Compact and
 * unboxed: place it at the end of the card's title row (`GameAppCard` status slot does this).
 */
export function CraftStatusMark({ ready, verb = "build" }: { ready: boolean; verb?: "build" | "craft" }): React.JSX.Element {
  const label = ready ? `Can ${verb}` : `Cannot ${verb} yet`;
  return <span className="craft-status-mark" data-state={ready ? "ready" : "blocked"} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {ready ? <path d="M3 8.5l3.2 3.2L13 4.8" /> : <path d="M4 8h8" />}
    </svg>
  </span>;
}
