import {
  KITCHEN_COOK_ANY_CATEGORY,
  KITCHEN_COOK_ANY_RECIPE_ID,
  KITCHEN_MAX_BATCH_SIZE,
  KITCHEN_RECIPE_IDS,
  KITCHEN_RECIPES,
  categoryCandidates,
  highGradeGuardMessage,
  type InventoryProtectionSnapshot,
  KITCHEN_PROCESS_DURATION_MS,
  KITCHEN_RECIPE_CATEGORIES,
  kitchenRecipeCategory,
  kitchenOutputQuantity,
  requireKitchenRecipe,
  type KitchenRecipeId,
  type KitchenRecipeCategory,
  type KitchenStateSnapshot,
  type KitchenWorldSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameAppActionBar, GameAppCard, GameAppShell, GameAppTabs } from "./GameAppShell.js";
import { GENERIC_ITEM_ARTWORK_URL, itemArtworkSource, ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChips } from "./MaterialRequirements.js";
import { CategoryInputChips, HighGradeGuardPrompt, spendableCounts, useCategoryPreview } from "./MaterialCategoryUi.js";
import type { StationStartOptions } from "../client/domains/manorClient.js";
import { PhoneMenuFooterButtons } from "./PhoneMenuDestinationShell.js";

export function KitchenActionPrompt(props: Readonly<{
  kitchen: KitchenWorldSnapshot;
  state: KitchenStateSnapshot | null;
  connected: boolean;
  feedback: string | null;
  collecting: boolean;
  onCook(): void;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const disabledReason = props.connected ? null : "Cannot use a Kitchen while disconnected.";
  const readyQuantity = props.state?.kitchen.kitchenId === props.kitchen.kitchenId
    ? props.state.jobs.reduce((total, job) => total + job.readyQuantity, 0)
    : 0;
  return <GameActionPrompt
    title="Kitchen"
    message={props.feedback ? { text: props.feedback } : null}
    actions={[
      ...(readyQuantity > 0 ? [{
        key: "collect", label: `Collect ${readyQuantity} Simple Food`, enabled: disabledReason === null,
        busy: props.collecting, disabledReason, onSelect: props.onCollect
      }] : []),
      {
        key: "cook", label: "Use", enabled: disabledReason === null && !props.collecting,
        disabledReason, tone: readyQuantity > 0 ? "secondary" as const : "primary" as const,
        onSelect: props.onCook
      }
    ]}
    onCancel={props.onClose}
  />;
}

export function KitchenPrompt(props: Readonly<{
  state: KitchenStateSnapshot | null;
  inventory: PlayerInventorySnapshot;
  feedback: string | null;
  busy: boolean;
  layout?: "desktop" | "phone";
  protection?: InventoryProtectionSnapshot | null;
  onStart(recipeId: KitchenRecipeId | typeof KITCHEN_COOK_ANY_RECIPE_ID, quantity: number, options?: StationStartOptions): boolean;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const [guard, setGuard] = useState<Readonly<{ message: string; send(): void }> | null>(null);
  const spendable = spendableCounts(props.inventory, props.protection);
  const [recipeId, setRecipeId] = useState<KitchenRecipeId>(KITCHEN_RECIPE_IDS[0]);
  const recipe = requireKitchenRecipe(recipeId);
  const [batchQuantity, setBatchQuantity] = useState(() => kitchenMinimumBatchQuantity(recipe));
  const [clock, setClock] = useState(Date.now());
  const [view, setView] = useState<"recipes" | "queue">("recipes");
  const [category, setCategory] = useState<KitchenRecipeCategory>("raw");
  const jobs = props.state?.jobs ?? [];
  const queueRemaining = Math.max(0, (props.state?.queueCapacity ?? 5) - (props.state?.occupiedSlots ?? 0));
  const ownedQuantity = spendable.get(recipe.inputItemId) ?? 0;
  const materialCapacity = kitchenMaterialInputCapacity(recipe, ownedQuantity);
  const materialBatchCapacity = Math.floor(materialCapacity / recipe.inputPerOutput);
  const minimumBatchQuantity = kitchenMinimumBatchQuantity(recipe);
  const maximumBatchQuantity = kitchenMaximumBatchQuantity(recipe);
  const inputQuantity = batchQuantity * recipe.inputPerOutput;
  const affordable = queueRemaining > 0 && materialCapacity >= inputQuantity;
  const readyQuantity = jobs.reduce((total, job) => total + job.readyQuantity, 0);
  const nextCompletion = jobs.find((candidate) => !candidate.productionFinished)?.completesAt ?? null;

  useEffect(() => {
    setBatchQuantity((current) => Math.min(
      maximumBatchQuantity,
      Math.max(minimumBatchQuantity, current)
    ));
  }, [recipe.inputPerOutput, recipe.maximumQuantity, recipe.minimumQuantity, recipeId]);
  useEffect(() => {
    if (!nextCompletion) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nextCompletion]);

  const outputQuantity = kitchenOutputQuantity(recipe.recipeId, inputQuantity);
  const actionStatus = view === "queue"
    ? readyQuantity > 0 ? `${readyQuantity} ready to collect`
      : jobs.length > 0 ? `${props.state?.occupiedSlots ?? 0} of ${props.state?.queueCapacity ?? 5} slots filled` : "Queue is empty"
    : queueRemaining === 0 ? "Queue is full" : `${queueRemaining} queue slots open`;
  const layout = props.layout ?? "desktop";
  const actionBar = <GameAppActionBar>
    <small>{actionStatus}</small>
    {view === "queue" ? <button
      type="button"
      className="primary"
      disabled={props.busy || readyQuantity === 0}
      onClick={props.onCollect}
    >Collect {readyQuantity} {readyQuantity === 1 ? "item" : "items"}</button> : <button
      type="button"
      className="primary"
      disabled={props.busy || !props.state || !affordable || queueRemaining === 0}
      onClick={() => {
        const send = () => {
          const started = (recipe.breakdownGrade ?? 0) >= 4
            ? props.onStart(recipeId, inputQuantity, { confirmHighGrade: true })
            : props.onStart(recipeId, inputQuantity);
          if (started) setView("queue");
        };
        if ((recipe.breakdownGrade ?? 0) >= 4) {
          setGuard({ message: highGradeGuardMessage([{ itemId: recipe.inputItemId, quantity: inputQuantity }]), send });
          return;
        }
        send();
      }}
    >Queue {outputQuantity} {recipe.outputDisplayName}</button>}
  </GameAppActionBar>;

  return <GameAppShell
    open title="Kitchen"
    closeLabel="Close Kitchen" className="furnace-app kitchen-app" layout={layout}
    phoneBackLabel={view === "queue" ? "Back to Kitchen" : "Back to World"}
    phoneOnBack={view === "queue" ? () => setView("recipes") : props.onClose}
    phoneOnReturnToGame={props.onClose}
    closeDisabled={props.busy}
    footer={layout === "desktop" ? <PhoneMenuFooterButtons
      backLabel="Back to World"
      onBack={props.onClose}
      onReturnToGame={props.onClose}
      navigationDisabled={props.busy}
    /> : undefined}
    onClose={props.onClose}
  >
    <GameAppTabs tabs={[{ id: "recipes", label: "Recipes" }, { id: "queue", label: "Queue" }]}
      activeTab={view} ariaLabel="Kitchen sections" variant="housed"
      onChange={(id) => setView(id as "recipes" | "queue")} />
    <div className="kitchen-workspace">
      {props.feedback ? <p className="furnace-status-copy" role="status">{props.feedback}</p> : null}
      {!props.state ? <GameAppCard title="Preparing Kitchen" badge="Loading">
        <p className="furnace-empty-copy">Checking the station and your materials…</p>
      </GameAppCard> : view === "queue" ? <GameAppCard title="Production queue" badge={`${props.state.occupiedSlots} / ${props.state.queueCapacity} slots`} action={actionBar}>
        {jobs.length > 0 ? <div className="furnace-queue">{jobs.map((job, index) => <KitchenQueueJob key={job.jobId} job={job} index={index} clock={clock} />)}</div>
          : <p className="furnace-empty-copy">No work is queued. Go back to choose a recipe.</p>}
      </GameAppCard> : <div className="kitchen-workspace-main">
        <section className="kitchen-picker" aria-label="Kitchen ingredient picker">
          <header className="kitchen-picker-header">
            <div><span>Ingredients</span><strong>Choose what to cook</strong></div>
            {jobs.length > 0 ? <button type="button" className="furnace-view-queue" onClick={() => setView("queue")}>View queue · {props.state.occupiedSlots} / {props.state.queueCapacity}</button> : null}
          </header>
          {category === "raw" ? <KitchenCookAny
            spendable={spendable}
            freeSlots={queueRemaining}
            busy={props.busy}
            onCook={(quantity, options) => {
              if (props.onStart(KITCHEN_COOK_ANY_RECIPE_ID, quantity, options)) setView("queue");
            }}
            onGuard={setGuard}
          /> : null}
          <KitchenRecipeTabs category={category} onChange={(next) => {
            setCategory(next);
            const first = KITCHEN_RECIPE_IDS.find((id) => kitchenRecipeCategory(id) === next)!;
            setRecipeId(first);
            setBatchQuantity(kitchenMinimumBatchQuantity(requireKitchenRecipe(first)));
          }} />
          <nav className="kitchen-picker-list" aria-label="Kitchen ingredients">
            {Object.values(KITCHEN_RECIPES).filter((candidate) => kitchenRecipeCategory(candidate.recipeId) === category).map((candidate) => {
              const candidateOwned = spendable.get(candidate.inputItemId) ?? 0;
              const candidateBatches = Math.floor(kitchenMaterialInputCapacity(candidate, candidateOwned) / candidate.inputPerOutput);
              const selected = candidate.recipeId === recipeId;
              return <button
                key={candidate.recipeId}
                type="button"
                aria-pressed={selected}
                data-selected={selected}
                onClick={() => { setRecipeId(candidate.recipeId); setBatchQuantity(kitchenMinimumBatchQuantity(candidate)); }}
                disabled={props.busy}
              >
                <span className="kitchen-picker-art" aria-hidden="true">{hasKitchenPickerArtwork(candidate.inputItemId) ? <ItemArtwork itemId={candidate.inputItemId} label={candidate.inputDisplayName} /> : null}</span>
                <span className="kitchen-picker-copy"><strong>{candidate.inputDisplayName}</strong><small>{candidateOwned} owned · {candidateBatches} batches</small></span>
                {selected ? <span className="kitchen-selection-mark" aria-hidden="true">✓ Selected</span> : null}
              </button>;
            })}
          </nav>
        </section>
        <section className="kitchen-selected" aria-label="Selected Kitchen recipe">
          <GameAppCard title={`${recipe.inputDisplayName} → ${outputQuantity} ${recipe.outputDisplayName}`} leading={<ItemArtwork itemId={recipe.outputItemId} label={recipe.outputDisplayName} />} status={<CraftStatusMark ready={affordable} verb="craft" />} action={actionBar}>
            <div className="kitchen-tray">
              <div className="kitchen-tray-meta"><MaterialChips label={`${recipe.outputDisplayName} materials`} materials={[{ itemId: recipe.inputItemId, name: recipe.inputDisplayName, quantity: inputQuantity, have: ownedQuantity }]} /><span>{recipe.durationMs / 1_000} sec</span></div>
              <div className="kitchen-tray-quantity" aria-label="Simple Food batch quantity"><button type="button" aria-label="Decrease Simple Food batch quantity" disabled={batchQuantity <= minimumBatchQuantity || props.busy} onClick={() => setBatchQuantity((value) => Math.max(minimumBatchQuantity, value - 1))}>−</button><div><span>Batches</span><strong>{batchQuantity}</strong></div><button type="button" className="kitchen-quantity-max" disabled={materialBatchCapacity < minimumBatchQuantity || batchQuantity === materialBatchCapacity || props.busy} onClick={() => setBatchQuantity(materialBatchCapacity)}>Max</button><button type="button" aria-label="Increase Simple Food batch quantity" disabled={batchQuantity >= maximumBatchQuantity || props.busy} onClick={() => setBatchQuantity((value) => Math.min(maximumBatchQuantity, value + 1))}>+</button></div>
            </div>
          </GameAppCard>
        </section>
      </div>}
    </div>
    {guard ? <HighGradeGuardPrompt
      message={guard.message}
      onChooseAnother={() => setGuard(null)}
      onUseIt={() => { const pending = guard; setGuard(null); pending.send(); }}
    /> : null}
  </GameAppShell>;
}

function KitchenQueueJob(props: Readonly<{ job: KitchenStateSnapshot["jobs"][number]; index: number; clock: number }>): React.JSX.Element {
  const queued = Date.parse(props.job.startedAt) > props.clock;
  const nextRemaining = !props.job.productionFinished ? Math.max(0, Date.parse(props.job.completesAt) - props.clock) : null;
  const progress = !props.job.productionFinished && !queued ? Math.min(1, Math.max(0, 1 - (Date.parse(props.job.completesAt) - props.clock) / KITCHEN_PROCESS_DURATION_MS)) : props.job.productionFinished ? 1 : 0;
  const status = props.job.productionFinished ? "Complete" : queued ? "Queued" : "In progress";
  return <article className="furnace-queue-job" data-status={status.toLowerCase().replace(" ", "-")}><div className="furnace-output-summary"><ItemArtwork itemId={props.job.outputItemId} label={props.job.outputDisplayName} /><div><span>{!queued && !props.job.productionFinished ? "Active work order" : `Queue position ${props.index + 1}`}</span><strong>{props.job.outputQuantity} Simple Food</strong><small>{status}</small></div></div><div className="furnace-progress" role="progressbar" aria-label="Progress toward Simple Food" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div><div className="furnace-job-state"><strong>{props.job.readyQuantity > 0 ? `${props.job.readyQuantity} ready to collect` : nextRemaining !== null ? `${queued ? "Begins after earlier work · ready" : "Next ready"} in ${formatRemaining(nextRemaining)}` : "Production complete"}</strong><small>{queued ? "Materials reserved. The Kitchen will start this automatically." : "The Kitchen continues while you travel."}</small></div></article>;
}

export function KitchenRecipeTabs(props: Readonly<{
  category: KitchenRecipeCategory;
  onChange(category: KitchenRecipeCategory): void;
}>): React.JSX.Element {
  return <GameAppTabs tabs={KITCHEN_RECIPE_CATEGORIES} activeTab={props.category}
    ariaLabel="Kitchen recipe types" variant="subtabs" scrollable
    onChange={(id) => props.onChange(id as KitchenRecipeCategory)} />;
}

function kitchenMinimumBatchQuantity(recipe: ReturnType<typeof requireKitchenRecipe>): number {
  return Math.ceil(recipe.minimumQuantity / recipe.inputPerOutput);
}

function kitchenMaximumBatchQuantity(recipe: ReturnType<typeof requireKitchenRecipe>): number {
  return Math.floor(recipe.maximumQuantity / recipe.inputPerOutput);
}

function kitchenMaterialInputCapacity(recipe: ReturnType<typeof requireKitchenRecipe>, owned: number): number {
  const capped = Math.min(recipe.maximumQuantity, Math.max(0, owned));
  return capped - (capped % recipe.inputPerOutput);
}

function hasKitchenPickerArtwork(itemId: string): boolean {
  return itemArtworkSource(itemId) !== GENERIC_ITEM_ARTWORK_URL;
}

function formatRemaining(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}


/** "Cook any Meat / Fish": lowest grade first, exact items shown, as many as the free slots fit. */
function KitchenCookAny(props: Readonly<{
  spendable: ReadonlyMap<string, number>;
  freeSlots: number;
  busy: boolean;
  onCook(quantity: number, options: StationStartOptions): void;
  onGuard(guard: Readonly<{ message: string; send(): void }>): void;
}>): React.JSX.Element | null {
  const held = categoryCandidates(KITCHEN_COOK_ANY_CATEGORY, props.spendable);
  // Each concrete item needs its own job of up to 50, so count the jobs the free slots allow.
  let quantity = 0;
  let slots = props.freeSlots;
  for (const candidate of held) {
    for (let left = candidate.quantity; left > 0 && slots > 0; left -= KITCHEN_MAX_BATCH_SIZE, slots -= 1) {
      quantity += Math.min(left, KITCHEN_MAX_BATCH_SIZE);
    }
  }
  const inputs = [{ category: KITCHEN_COOK_ANY_CATEGORY, quantity: Math.max(1, quantity) }];
  const preview = useCategoryPreview([], inputs, props.spendable);
  if (held.length === 0) return null;
  const total = held.reduce((sum, candidate) => sum + candidate.quantity, 0);
  return <section className="kitchen-cook-any" aria-label="Cook any Meat or Fish">
    <header><strong>Cook any Meat / Fish</strong><small>Lowest grade first · {total - quantity > 0 ? `${total - quantity} wait for free slots` : "everything fits"}</small></header>
    <CategoryInputChips
      inputs={inputs}
      preview={preview}
      spendable={props.spendable}
      preferred={preview.preferred}
      onPrefer={preview.prefer}
    />
    <button
      type="button"
      className="primary"
      disabled={props.busy || quantity === 0 || !preview.ready}
      onClick={() => {
        const send = (confirmHighGrade: boolean) => props.onCook(quantity, {
          categoryPicks: preview.picks.map((list) => list.map((pick) => ({ ...pick }))),
          ...(confirmHighGrade ? { confirmHighGrade: true } : {})
        });
        if (preview.guardMessage) {
          props.onGuard({ message: preview.guardMessage, send: () => send(true) });
          return;
        }
        send(false);
      }}
    >Cook {quantity}</button>
  </section>;
}
