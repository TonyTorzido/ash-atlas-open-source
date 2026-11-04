import {
  HIGH_GRADE_MIN,
  INVENTORY_CATALOG,
  categoryCandidates,
  highGradeGuardMessage,
  materialCategory,
  materialGrade,
  pickCategoryInputs,
  type CategoryPick,
  type CategoryRecipeInput,
  type ExactRecipeInput,
  type InventoryProtectionSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameAppButton, GameAppSectionHeader } from "./GameAppShell.js";
import { ItemArtwork, itemArtworkSource, itemArtworkStyle } from "./ItemArtwork.js";
import { useItemNameTooltip } from "./ItemNameTooltip.js";

/**
 * Shared station UI for graded materials (DROPS-PROGRESSION-DESIGN 2.1): exact-item chips with a
 * grade pip for category inputs, the high-grade guard, and the Breakdown section.
 */

/** Spendable quantity per item: inventory minus stacks held back by keep policies (R4). */
export function spendableCounts(
  inventory: PlayerInventorySnapshot,
  protection?: InventoryProtectionSnapshot | null
): Map<string, number> {
  const counts = new Map<string, number>(
    Object.entries(inventory.totals).filter(([, quantity]) => typeof quantity === "number" && quantity > 0) as [string, number][]
  );
  for (const allocation of protection?.stackAllocations ?? []) {
    if ((allocation.variant ?? "default") !== "default" || allocation.protectedQuantity <= 0) continue;
    counts.set(allocation.itemId, Math.max(0, (counts.get(allocation.itemId) ?? 0) - allocation.protectedQuantity));
  }
  return counts;
}

function displayName(itemId: string): string {
  return INVENTORY_CATALOG[itemId]?.displayName ?? itemId;
}

/** "Jaguar Cut, grade 3, you have 4" (long-press / hover text). */
export function gradedItemLabel(itemId: string, have: number): string {
  return `${displayName(itemId)}, grade ${materialGrade(itemId) ?? 1}, you have ${have.toLocaleString()}`;
}

export function GradePip({ itemId }: { itemId: string }): React.JSX.Element {
  const grade = materialGrade(itemId) ?? 1;
  return <i className="material-grade-pip" data-grade={grade} aria-hidden="true">{grade}</i>;
}

function PickChip({ pick, have, selected, onSelect }: {
  pick: CategoryPick;
  have: number;
  selected?: boolean;
  onSelect?: () => void;
}): React.JSX.Element {
  const label = gradedItemLabel(pick.itemId, have);
  const { bind, tip } = useItemNameTooltip(label);
  return <>
    <button
      type="button"
      className="phone-build-material-requirement material-chip material-category-chip"
      data-state="met"
      aria-pressed={selected}
      aria-label={`${label}. Uses ${pick.quantity}.`}
      onClick={onSelect}
      {...bind}
    >
      <img className="phone-build-material-artwork item-artwork" style={itemArtworkStyle(pick.itemId)} src={itemArtworkSource(pick.itemId, null)} alt="" aria-hidden="true" />
      <GradePip itemId={pick.itemId} />
      <b>{pick.quantity.toLocaleString()}</b>
    </button>
    {tip}
  </>;
}

export type CategoryPreview = Readonly<{
  /** Picks to send with the request (always the ones shown, R7). */
  picks: CategoryPick[][];
  /** False when the player cannot cover every input. */
  ready: boolean;
  /** Non-empty when the guard must be confirmed before sending (R5). */
  guardMessage: string | null;
}>;

/**
 * Preview of a recipe's category inputs with optional preferred items (R6), computed with the
 * same shared picker the server debits with (R3).
 */
export function useCategoryPreview(
  exactInputs: readonly ExactRecipeInput[],
  categoryInputs: readonly CategoryRecipeInput[],
  spendable: ReadonlyMap<string, number>
): CategoryPreview & { preferred: (string | null)[]; prefer(index: number, itemId: string | null): void } {
  const [preferred, setPreferred] = useState<(string | null)[]>([]);
  const key = categoryInputs.map((input) => input.category.label).join("|");
  useEffect(() => setPreferred([]), [key]);
  const preview = useMemo((): CategoryPreview => {
    const auto = pickCategoryInputs(exactInputs, categoryInputs, spendable);
    let picks = auto.ok ? auto.picks.map((list) => [...list]) : [];
    if (preferred.some((itemId) => itemId)) {
      // Preferred item first, then the remaining lowest-grade items.
      const requested = categoryInputs.map((input, index) => {
        const want = preferred[index];
        const list: CategoryPick[] = [];
        let need = input.quantity;
        const pool = categoryCandidates(input.category, spendable);
        const ordered = want ? [...pool.filter((pick) => pick.itemId === want), ...pool.filter((pick) => pick.itemId !== want)] : pool;
        for (const candidate of ordered) {
          if (need === 0) break;
          const quantity = Math.min(need, candidate.quantity);
          list.push({ itemId: candidate.itemId, quantity });
          need -= quantity;
        }
        return list;
      });
      const checked = pickCategoryInputs(exactInputs, categoryInputs, spendable, requested);
      if (checked.ok) picks = requested;
    }
    const resolved = pickCategoryInputs(exactInputs, categoryInputs, spendable, picks.length ? picks : undefined);
    return {
      picks,
      ready: resolved.ok,
      guardMessage: resolved.ok && resolved.highGrade.length > 0 ? highGradeGuardMessage(resolved.highGrade) : null
    };
  }, [categoryInputs, exactInputs, preferred, spendable]);
  return {
    ...preview,
    preferred,
    prefer: (index, itemId) => setPreferred((current) => {
      const next = [...current];
      next[index] = itemId;
      return next;
    })
  };
}

/** One row per category input: the exact items that will be used; tap to choose another. */
export function CategoryInputChips({ inputs, preview, spendable, preferred, onPrefer }: {
  inputs: readonly CategoryRecipeInput[];
  preview: CategoryPreview;
  spendable: ReadonlyMap<string, number>;
  preferred: readonly (string | null)[];
  onPrefer(index: number, itemId: string | null): void;
}): React.JSX.Element | null {
  const [choosing, setChoosing] = useState<number | null>(null);
  if (inputs.length === 0) return null;
  return <div className="material-category-inputs">
    {inputs.map((input, index) => {
      const picks = preview.picks[index] ?? [];
      const candidates = categoryCandidates(input.category, spendable);
      return <div key={input.category.label} className="material-category-input" role="group" aria-label={`${input.quantity} ${input.category.label}`}>
        <span className="material-category-label">{input.quantity} {input.category.label}</span>
        <div className="material-chip-list">
          {picks.length > 0
            ? picks.map((pick) => <PickChip
              key={pick.itemId}
              pick={pick}
              have={spendable.get(pick.itemId) ?? 0}
              onSelect={() => setChoosing(choosing === index ? null : index)}
            />)
            : <span className="material-chip" data-state="short"><b>None held</b></span>}
        </div>
        {choosing === index && candidates.length > 1 ? <div className="material-category-choices" role="listbox" aria-label={`Choose ${input.category.label}`}>
          {candidates.map((candidate) => <PickChip
            key={candidate.itemId}
            pick={candidate}
            have={candidate.quantity}
            selected={preferred[index] === candidate.itemId}
            onSelect={() => {
              onPrefer(index, candidate.itemId);
              setChoosing(null);
            }}
          />)}
        </div> : null}
      </div>;
    })}
  </div>;
}

/** R5 prompt: "Use a rare find?" with Choose another / Use it. */
export function HighGradeGuardPrompt({ message, onChooseAnother, onUseIt }: {
  message: string;
  onChooseAnother(): void;
  onUseIt(): void;
}): React.JSX.Element {
  return <GameActionPrompt
    title="Use a rare find?"
    message={{ text: message }}
    modal
    actions={[
      { key: "another", label: "Choose another", enabled: true, tone: "secondary", onSelect: onChooseAnother },
      { key: "use", label: "Use it", enabled: true, tone: "primary", onSelect: onUseIt }
    ]}
    cancelLabel="Choose another"
    onCancel={onChooseAnother}
  />;
}

export type BreakdownRecipe = Readonly<{
  recipeId: string;
  inputItemId: string;
  outputItemId: string;
  outputDisplayName: string;
  outputPerInput: number;
  maximumQuantity: number;
  breakdownGrade?: number;
}>;

/**
 * Breakdown section: held graded items grouped by category, each selectable, plus "Break down all
 * grade 1-2 in this group" (one confirm; G4+ never joins the bulk run).
 */
export function BreakdownSection({ recipes, spendable, selectedRecipeId, busy, freeSlots, onSelect, onBreakDownAll }: {
  recipes: readonly BreakdownRecipe[];
  spendable: ReadonlyMap<string, number>;
  selectedRecipeId: string | null;
  busy: boolean;
  freeSlots: number;
  onSelect(recipeId: string): void;
  onBreakDownAll(batches: readonly Readonly<{ recipeId: string; quantity: number }>[]): void;
}): React.JSX.Element | null {
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const held = recipes.filter((recipe) => (spendable.get(recipe.inputItemId) ?? 0) > 0);
  if (held.length === 0) return null;
  const groups = new Map<string, BreakdownRecipe[]>();
  for (const recipe of held) {
    const group = materialCategory(recipe.inputItemId) ?? "other";
    groups.set(group, [...(groups.get(group) ?? []), recipe]);
  }
  const bulkFor = (list: readonly BreakdownRecipe[]) => list
    .filter((recipe) => (recipe.breakdownGrade ?? 1) <= 2)
    .flatMap((recipe) => {
      const batches: { recipeId: string; quantity: number }[] = [];
      for (let left = spendable.get(recipe.inputItemId) ?? 0; left > 0; left -= recipe.maximumQuantity) {
        batches.push({ recipeId: recipe.recipeId, quantity: Math.min(left, recipe.maximumQuantity) });
      }
      return batches;
    });
  return <section className="material-breakdown" aria-labelledby="material-breakdown-title">
    <GameAppSectionHeader title="Breakdown" titleId="material-breakdown-title" />
    {[...groups].map(([group, list]) => {
      const bulk = bulkFor(list);
      return <div key={group} className="material-breakdown-group">
        <div className="material-breakdown-group-head">
          <strong>{group[0]!.toUpperCase()}{group.slice(1)}</strong>
          {bulk.length > 0 ? <GameAppButton
            disabled={busy || freeSlots === 0}
            onClick={() => setConfirmGroup(group)}
          >Break down all grade 1-2</GameAppButton> : null}
        </div>
        <nav className="furnace-recipe-tabs" aria-label={`Break down ${group}`}>
          {list.map((recipe) => <button
            key={recipe.recipeId}
            type="button"
            aria-pressed={recipe.recipeId === selectedRecipeId}
            disabled={busy}
            title={gradedItemLabel(recipe.inputItemId, spendable.get(recipe.inputItemId) ?? 0)}
            onClick={() => onSelect(recipe.recipeId)}
          >
            <ItemArtwork itemId={recipe.inputItemId} label={displayName(recipe.inputItemId)} />
            <span>
              <strong>{displayName(recipe.inputItemId)} <GradePip itemId={recipe.inputItemId} /></strong>
              <small>{recipe.outputPerInput} {recipe.outputDisplayName} each</small>
            </span>
          </button>)}
        </nav>
        {confirmGroup === group ? <GameActionPrompt
          title="Break down all grade 1-2?"
          message={{ text: bulk.length > freeSlots
            ? `${freeSlots} of ${bulk.length} batches fit in the queue now; the rest stay in your bag.`
            : `${bulk.length} ${bulk.length === 1 ? "batch" : "batches"} will be queued. Breakdown cannot be undone.` }}
          modal
          actions={[{ key: "go", label: "Break down", enabled: true, tone: "primary", onSelect: () => {
            setConfirmGroup(null);
            onBreakDownAll(bulk.slice(0, freeSlots));
          } }]}
          onCancel={() => setConfirmGroup(null)}
        /> : null}
      </div>;
    })}
  </section>;
}

/** Sends queued bulk batches one at a time as each previous request settles. */
export function useSequentialStarts(
  busy: boolean,
  send: (recipeId: string, quantity: number) => boolean
): (batches: readonly Readonly<{ recipeId: string; quantity: number }>[]) => void {
  const queue = useRef<Readonly<{ recipeId: string; quantity: number }>[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (busy || queue.current.length === 0) return;
    const next = queue.current.shift()!;
    if (!send(next.recipeId, next.quantity)) queue.current = [];
  }, [busy, send, tick]);
  return (batches) => {
    queue.current = [...batches];
    setTick((value) => value + 1);
  };
}

const CATEGORY_BASIC_ICON: Readonly<Record<string, string>> = {
  bones: "bone", scales: "chitin", plants: "balsam_resin", fish: "freshwater_fish", venoms: "venom_sac"
};

/**
 * Material chips for category inputs ("5 any Bones"): the icon is the exact item the server will
 * spend first, and "have" counts every eligible item the player can spend.
 */
export function categoryNeeds(
  inputs: readonly CategoryRecipeInput[],
  spendable: ReadonlyMap<string, number>
): { itemId: string; quantity: number; name: string; have: number }[] {
  return inputs.map((input) => {
    const candidates = categoryCandidates(input.category, spendable);
    const first = candidates[0];
    return {
      itemId: first?.itemId ?? CATEGORY_BASIC_ICON[input.category.groups[0] ?? ""] ?? "bone",
      quantity: input.quantity,
      name: first ? `${input.category.label} (uses ${gradedItemLabel(first.itemId, first.quantity)} first)` : input.category.label,
      have: candidates.reduce((total, candidate) => total + candidate.quantity, 0)
    };
  });
}

export function isHighGrade(itemId: string): boolean {
  return (materialGrade(itemId) ?? 0) >= HIGH_GRADE_MIN;
}
