import {
  LOOM_RECIPES,
  highGradeGuardMessage,
  requireLoomRecipe,
  type InventoryProtectionSnapshot,
  type LoomStateSnapshot,
  type LoomWorldSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameAppActionBar, GameAppButton, GameAppCard, GameAppSectionHeader, GameAppShell } from "./GameAppShell.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChips } from "./MaterialRequirements.js";
import { BreakdownSection, HighGradeGuardPrompt, spendableCounts, useSequentialStarts } from "./MaterialCategoryUi.js";
import type { StationStartOptions } from "../client/domains/manorClient.js";

const LOOM_BREAKDOWN_RECIPES = Object.values(LOOM_RECIPES).filter((recipe) => recipe.breakdownGrade !== undefined);

export function LoomActionPrompt(props: Readonly<{
  loom: LoomWorldSnapshot;
  state: LoomStateSnapshot | null;
  /** Legacy compatibility; Loom access is determined by server-side exterior authority. */
  ownPlayerId?: string;
  connected: boolean;
  feedback: string | null;
  collecting: boolean;
  onWeave(): void;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const disabledReason = props.connected ? null : "Cannot use a Loom while disconnected.";
  const readyQuantity = props.state?.loom.loomId === props.loom.loomId
    ? props.state.jobs.reduce((total, job) => total + job.readyQuantity, 0)
    : 0;
  return <GameActionPrompt
    title="Loom"
    message={props.feedback ? { text: props.feedback } : null}
    actions={[
      ...(readyQuantity > 0 ? [{
        key: "collect", label: `Collect ${readyQuantity} Cloth`, enabled: disabledReason === null,
        busy: props.collecting, disabledReason, onSelect: props.onCollect
      }] : []),
      {
        key: "weave", label: "Use", enabled: disabledReason === null && !props.collecting,
        disabledReason, tone: readyQuantity > 0 ? "secondary" as const : "primary" as const,
        onSelect: () => props.onWeave()
      }
    ]}
    onCancel={props.onClose}
  />;
}

export function LoomPrompt(props: Readonly<{
  state: LoomStateSnapshot | null;
  inventory: PlayerInventorySnapshot;
  feedback: string | null;
  busy: boolean;
  layout?: "desktop" | "phone";
  protection?: InventoryProtectionSnapshot | null;
  onStart(quantity: number, recipeId?: string, options?: StationStartOptions): boolean;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const [recipeId, setRecipeId] = useState("flax_fiber");
  const [guard, setGuard] = useState<string | null>(null);
  const recipe = requireLoomRecipe(recipeId);
  const step = recipe.inputMultiple;
  const spendable = spendableCounts(props.inventory, props.protection);
  const startBulk = useSequentialStarts(props.busy, (bulkRecipeId, bulkQuantity) => props.onStart(bulkQuantity, bulkRecipeId));
  const [quantity, setQuantity] = useState(recipe.minimumQuantity);
  const [clock, setClock] = useState(Date.now());
  const [view, setView] = useState<"recipes" | "queue">("recipes");
  const jobs = props.state?.jobs ?? [];
  const queueRemaining = Math.max(0, (props.state?.queueCapacity ?? 5) - (props.state?.occupiedSlots ?? 0));
  const rawMaterialCapacity = Math.min(recipe.maximumQuantity, spendable.get(recipe.inputItemId) ?? 0);
  const materialCapacity = rawMaterialCapacity - (rawMaterialCapacity % step);
  const affordable = queueRemaining > 0 && materialCapacity >= quantity;
  const readyQuantity = jobs.reduce((total, job) => total + job.readyQuantity, 0);
  const nextCompletion = jobs.find((candidate) => !candidate.productionFinished)?.completesAt ?? null;

  useEffect(() => {
    setQuantity((current) => {
      const bounded = Math.min(recipe.maximumQuantity, Math.max(recipe.minimumQuantity, current));
      return bounded - (bounded % step);
    });
  }, [recipe.maximumQuantity, recipe.minimumQuantity, queueRemaining, step]);
  useEffect(() => {
    if (!nextCompletion) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nextCompletion]);

  const outputQuantity = Math.floor(quantity * recipe.outputPerInput);
  const actionStatus = view === "queue"
    ? readyQuantity > 0 ? `${readyQuantity} ready to collect`
      : jobs.length > 0 ? `${props.state?.occupiedSlots ?? 0} of ${props.state?.queueCapacity ?? 5} slots filled` : "Queue is empty"
    : queueRemaining === 0 ? "Queue is full" : `${recipe.durationMs / 1_000} seconds total`;

  return <GameAppShell
    open title="Loom"
    closeLabel="Close Loom" className="furnace-app loom-app" layout={props.layout ?? "desktop"}
    phoneBackLabel={view === "queue" ? "Back to Loom" : "Back to World"}
    phoneOnBack={view === "queue" ? () => setView("recipes") : props.onClose}
    phoneOnReturnToGame={props.onClose} closeDisabled={props.busy} onClose={props.onClose}
    footer={<GameAppActionBar><small>{actionStatus}</small>{view === "queue" ? <GameAppButton
          variant="primary"
          disabled={props.busy || readyQuantity === 0}
      onClick={props.onCollect}>Collect {readyQuantity} {readyQuantity === 1 ? "item" : "items"}</GameAppButton> : <GameAppButton
          variant="primary"
          disabled={props.busy || !props.state || !affordable || queueRemaining === 0}
      onClick={() => {
        if ((recipe.breakdownGrade ?? 0) >= 4) {
          setGuard(highGradeGuardMessage([{ itemId: recipe.inputItemId, quantity }]));
          return;
        }
        if (props.onStart(quantity, recipeId)) setView("queue");
      }}
    >Queue {outputQuantity} {recipe.outputDisplayName}</GameAppButton>}</GameAppActionBar>}
  >
    <div className="furnace-workspace">
      {props.feedback ? <p className="furnace-status-copy" role="status">{props.feedback}</p> : null}
      {!props.state ? <GameAppCard title="Preparing Loom" badge="Loading">
        <p className="furnace-empty-copy">Checking the station and your materials…</p>
      </GameAppCard> : view === "queue" ? <GameAppCard title="Production queue" badge={`${props.state.occupiedSlots} / ${props.state.queueCapacity} slots`}>
        {jobs.length > 0 ? <div className="furnace-queue">{jobs.map((job, index) => <LoomQueueJob key={job.jobId} job={job} index={index} clock={clock} />)}</div>
          : <p className="furnace-empty-copy">No work is queued. Go back to choose a recipe.</p>}
      </GameAppCard> : <>
        {jobs.length > 0 ? <GameAppButton className="furnace-view-queue" onClick={() => setView("queue")}>View queue · {props.state.occupiedSlots} / {props.state.queueCapacity} slots</GameAppButton> : null}
        <nav className="furnace-recipe-tabs" aria-label="Loom recipes">
          {[LOOM_RECIPES.flax_fiber].map((candidate) => <button key={candidate.recipeId} type="button" aria-pressed={recipeId === candidate.recipeId} disabled={props.busy} onClick={() => setRecipeId(candidate.recipeId)}>
            <ItemArtwork itemId={candidate.inputItemId} label={candidate.inputDisplayName} /><span><strong>{candidate.inputDisplayName}</strong><small>{candidate.displayName}</small></span>
          </button>)}
        </nav>
        <BreakdownSection
          recipes={LOOM_BREAKDOWN_RECIPES}
          spendable={spendable}
          selectedRecipeId={recipeId}
          busy={props.busy}
          freeSlots={queueRemaining}
          onSelect={setRecipeId}
          onBreakDownAll={(batches) => { startBulk(batches); setView("queue"); }}
        />
        <GameAppCard title={recipe.displayName} status={<CraftStatusMark ready={affordable} verb="craft" />}>
          <div className="furnace-recipe-detail">
            <div className="furnace-output-summary"><ItemArtwork itemId={recipe.outputItemId} label={recipe.outputDisplayName} /><div><span>Output</span><strong>{outputQuantity} {recipe.outputDisplayName}</strong><small>{quantity} {recipe.inputDisplayName} · completed as one batch</small></div></div>
            <div className="furnace-quantity" aria-label="Cloth quantity"><GameAppButton type="button" aria-label="Decrease Cloth quantity" disabled={quantity <= recipe.minimumQuantity || props.busy} onClick={() => setQuantity((value) => Math.max(recipe.minimumQuantity, value - step))}>−</GameAppButton><div><span>Batch</span><strong>{quantity}</strong></div><GameAppButton type="button" className="furnace-quantity-max" disabled={materialCapacity < recipe.minimumQuantity || quantity === materialCapacity || props.busy} onClick={() => setQuantity(materialCapacity)}>Max</GameAppButton><GameAppButton type="button" aria-label="Increase Cloth quantity" disabled={quantity >= recipe.maximumQuantity || props.busy} onClick={() => setQuantity((value) => Math.min(recipe.maximumQuantity, value + step))}>+</GameAppButton></div>
            <section className="furnace-materials" aria-labelledby="loom-materials-title"><GameAppSectionHeader title="Materials" titleId="loom-materials-title" />
                <MaterialChips label={`${recipe.displayName} materials`} materials={[{ itemId: recipe.inputItemId, name: recipe.inputDisplayName, quantity, have: spendable.get(recipe.inputItemId) ?? 0 }]} /></section>
            <dl className="game-app-stats furnace-recipe-facts"><div><dt>Time</dt><dd>{recipe.durationMs / 1_000} seconds total</dd></div><div><dt>Queue space</dt><dd>{queueRemaining} of {props.state.queueCapacity}</dd></div></dl>
          </div>
        </GameAppCard>
      </>}
    </div>
    {guard ? <HighGradeGuardPrompt
      message={guard}
      onChooseAnother={() => setGuard(null)}
      onUseIt={() => {
        setGuard(null);
        if (props.onStart(quantity, recipeId, { confirmHighGrade: true })) setView("queue");
      }}
    /> : null}
  </GameAppShell>;
}

function LoomQueueJob(props: Readonly<{ job: LoomStateSnapshot["jobs"][number]; index: number; clock: number }>): React.JSX.Element {
  const recipe = requireLoomRecipe(props.job.recipeId);
  const queued = Date.parse(props.job.startedAt) > props.clock;
  const nextRemaining = !props.job.productionFinished ? Math.max(0, Date.parse(props.job.completesAt) - props.clock) : null;
  const progress = !props.job.productionFinished && !queued ? Math.min(1, Math.max(0, 1 - (Date.parse(props.job.completesAt) - props.clock) / recipe.durationMs)) : props.job.productionFinished ? 1 : 0;
  const status = props.job.productionFinished ? "Complete" : queued ? "Queued" : "In progress";
  return <article className="furnace-queue-job" data-status={status.toLowerCase().replace(" ", "-")}><div className="furnace-output-summary"><ItemArtwork itemId={props.job.outputItemId} label={props.job.outputDisplayName} /><div><span>{!queued && !props.job.productionFinished ? "Active work order" : `Queue position ${props.index + 1}`}</span><strong>{props.job.outputQuantity} Cloth</strong><small>{status}</small></div></div><div className="game-app-progress furnace-progress" role="progressbar" aria-label="Progress toward Cloth" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div><div className="furnace-job-state"><strong>{props.job.readyQuantity > 0 ? `${props.job.readyQuantity} ready to collect` : nextRemaining !== null ? `${queued ? "Begins after earlier work · ready" : "Next ready"} in ${formatRemaining(nextRemaining)}` : "Production complete"}</strong><small>{queued ? "Materials reserved. The Loom will start this automatically." : "The Loom continues while you travel."}</small></div></article>;
}

function formatRemaining(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
