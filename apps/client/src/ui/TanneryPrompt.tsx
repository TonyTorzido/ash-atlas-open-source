import {
  TANNERY_RARE_HIDE_IDS,
  TANNERY_RECIPES,
  highGradeGuardMessage,
  requireTanneryRecipe,
  type InventoryProtectionSnapshot,
  type TanneryRecipeId,
  type TanneryStateSnapshot,
  type TanneryWorldSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameAppActionBar, GameAppButton, GameAppCard, GameAppSectionHeader, GameAppShell } from "./GameAppShell.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChips } from "./MaterialRequirements.js";
import { BreakdownSection, HighGradeGuardPrompt, spendableCounts, useSequentialStarts } from "./MaterialCategoryUi.js";
import type { StationStartOptions } from "../client/domains/manorClient.js";

const TANNERY_BREAKDOWN_RECIPES = Object.values(TANNERY_RECIPES).filter((recipe) => recipe.breakdownGrade !== undefined);

export function TanneryActionPrompt(props: Readonly<{
  tannery: TanneryWorldSnapshot;
  state: TanneryStateSnapshot | null;
  ownPlayerId: string;
  connected: boolean;
  feedback: string | null;
  collecting: boolean;
  onTan(): void;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const owned = props.tannery.ownerPlayerId === props.ownPlayerId;
  const disabledReason = !owned
    ? `Owned by ${props.tannery.ownerUsername}.`
    : props.connected ? null : "Cannot use a Tannery while disconnected.";
  const readyJob = props.state?.tannery.tanneryId === props.tannery.tanneryId &&
    props.state.jobs.find((job) => job.readyQuantity > 0);
  const readyQuantity = props.state?.jobs.reduce((total, job) => total + job.readyQuantity, 0) ?? 0;
  return <GameActionPrompt
    title="Tannery"
    message={props.feedback ? { text: props.feedback } : null}
    actions={[
      ...(readyJob && readyQuantity > 0 ? [{
        key: "collect",
        label: `Collect ${readyQuantity} ${readyQuantity === 1 ? "item" : "items"}`,
        enabled: disabledReason === null,
        busy: props.collecting,
        disabledReason,
        onSelect: props.onCollect
      }] : []),
      {
        key: "tan",
        label: "Use",
        enabled: disabledReason === null && !props.collecting,
        disabledReason,
        tone: readyJob ? "secondary" as const : "primary" as const,
        onSelect: () => props.onTan()
      }
    ]}
    onCancel={props.onClose}
  />;
}

export function TanneryPrompt(props: Readonly<{
  state: TanneryStateSnapshot | null;
  inventory: PlayerInventorySnapshot;
  feedback: string | null;
  busy: boolean;
  layout?: "desktop" | "phone";
  protection?: InventoryProtectionSnapshot | null;
  onStart(recipeId: TanneryRecipeId, quantity: number, options?: StationStartOptions): boolean;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const [recipeId, setRecipeId] = useState<TanneryRecipeId>("deer_hide");
  const [quantity, setQuantity] = useState(1);
  const [clock, setClock] = useState(Date.now());
  const [view, setView] = useState<"recipes" | "queue">("recipes");
  const [guard, setGuard] = useState<string | null>(null);
  const recipe = requireTanneryRecipe(recipeId);
  const spendable = spendableCounts(props.inventory, props.protection);
  const startBulk = useSequentialStarts(props.busy, (bulkRecipeId, bulkQuantity) => props.onStart(bulkRecipeId as TanneryRecipeId, bulkQuantity));
  const jobs = props.state?.jobs ?? [];
  const queueRemaining = Math.max(0, (props.state?.queueCapacity ?? 5) - (props.state?.occupiedSlots ?? 0));
  const inputs = [{ itemId: recipe.inputItemId, displayName: recipe.inputDisplayName, quantity }];
  const affordable = queueRemaining > 0 && inputs.every(
    (input) => (spendable.get(input.itemId) ?? 0) >= input.quantity
  );
  const materialCapacity = Math.min(
    recipe.maximumQuantity,
    Math.floor(spendable.get(recipe.inputItemId) ?? 0)
  );
  const readyQuantity = jobs.reduce((total, candidate) => total + candidate.readyQuantity, 0);
  const nextCompletion = jobs.find((candidate) => !candidate.productionFinished)?.completesAt ?? null;

  useEffect(() => {
    const maximum = recipe.maximumQuantity;
    setQuantity((current) => Math.min(maximum, Math.max(recipe.minimumQuantity, current)));
  }, [queueRemaining, recipe.maximumQuantity, recipe.minimumQuantity]);
  useEffect(() => {
    if (!nextCompletion) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nextCompletion]);

  const outputLabel = formatOutputQuantity(
    quantity * recipe.outputPerInput,
    recipe.outputDisplayName
  );
  const actionStatus = view === "queue"
    ? readyQuantity > 0
      ? `${readyQuantity} ready to collect`
      : jobs.length > 0 ? `${props.state?.occupiedSlots ?? 0} of ${props.state?.queueCapacity ?? 5} slots filled` : "Queue is empty"
    : queueRemaining === 0 ? "Queue is full" : `${formatDuration(recipe.durationMs)} total`;

  return <>
    <GameAppShell
      open
      title="Tannery"
      closeLabel="Close Tannery"
      className="furnace-app tannery-app"
      layout={props.layout ?? "desktop"}
      phoneBackLabel={view === "queue" ? "Back to Tannery" : "Back to World"}
      phoneOnBack={view === "queue" ? () => setView("recipes") : props.onClose}
      phoneOnReturnToGame={props.onClose}
      closeDisabled={props.busy}
      onClose={props.onClose}
      footer={<GameAppActionBar>
        <small>{actionStatus}</small>
        {view === "queue" ? <GameAppButton
          variant="primary"
          disabled={props.busy || readyQuantity === 0}
          onClick={props.onCollect}
        >Collect {readyQuantity} {readyQuantity === 1 ? "item" : "items"}</GameAppButton> : <GameAppButton
          variant="primary"
          disabled={props.busy || !props.state || !affordable || queueRemaining === 0}
          onClick={() => {
            if ((recipe.breakdownGrade ?? 0) >= 4) {
              setGuard(highGradeGuardMessage([{ itemId: recipe.inputItemId, quantity }]));
              return;
            }
            if (props.onStart(recipeId, quantity)) setView("queue");
          }}
        >Queue {outputLabel}</GameAppButton>}
      </GameAppActionBar>}
    >
      <div className="furnace-workspace">
        {props.feedback ? <p className="furnace-status-copy" role="status">{props.feedback}</p> : null}
        {!props.state ? <GameAppCard title="Preparing Tannery" badge="Loading">
          <p className="furnace-empty-copy">Checking the station and your materials…</p>
        </GameAppCard> : view === "queue" ? <GameAppCard
          title="Production queue"
          badge={`${props.state.occupiedSlots} / ${props.state.queueCapacity} slots`}
        >
          {jobs.length > 0 ? <div className="furnace-queue">
            {jobs.map((candidate, index) => <TanneryQueueJob
              key={candidate.jobId}
              job={candidate}
              index={index}
              clock={clock}
            />)}
          </div> : <p className="furnace-empty-copy">No work is queued. Go back to choose a recipe.</p>}
        </GameAppCard> : <>
          {jobs.length > 0 ? <GameAppButton
            className="furnace-view-queue"
            onClick={() => setView("queue")}
          >View queue · {props.state.occupiedSlots} / {props.state.queueCapacity} slots</GameAppButton> : null}
          <nav className="furnace-recipe-tabs" aria-label="Tannery recipes">
            {TANNERY_RARE_HIDE_IDS.map((id) => TANNERY_RECIPES[id]!).map((candidate) => <button
              key={candidate.recipeId}
              type="button"
              aria-pressed={candidate.recipeId === recipeId}
              disabled={props.busy}
              onClick={() => setRecipeId(candidate.recipeId)}
            >
              <ItemArtwork itemId={candidate.inputItemId} label={candidate.inputDisplayName} />
              <span>
                <strong>{candidate.inputDisplayName}</strong>
                <small>{formatDuration(candidate.durationMs)}</small>
              </span>
            </button>)}
          </nav>
          <BreakdownSection
            recipes={TANNERY_BREAKDOWN_RECIPES}
            spendable={spendable}
            selectedRecipeId={recipeId}
            busy={props.busy}
            freeSlots={queueRemaining}
            onSelect={(id) => setRecipeId(id as TanneryRecipeId)}
            onBreakDownAll={(batches) => {
              startBulk(batches);
              setView("queue");
            }}
          />
          <GameAppCard title={recipe.displayName} status={<CraftStatusMark ready={affordable} verb="craft" />}>
            <div className="furnace-recipe-detail">
              <div className="furnace-output-summary">
                <ItemArtwork itemId={recipe.inputItemId} label={recipe.inputDisplayName} />
                <div>
                  <span>Output</span>
                  <strong>{outputLabel}</strong>
                  <small>{quantity} {recipe.inputDisplayName}{quantity === 1 ? "" : "s"} · completed as one batch</small>
                </div>
              </div>
              <div className="furnace-quantity" aria-label={`${recipe.outputDisplayName} quantity`}>
                <GameAppButton
                  type="button"
                  aria-label={`Decrease ${recipe.outputDisplayName} quantity`}
                  disabled={quantity <= recipe.minimumQuantity || props.busy}
                  onClick={() => setQuantity((value) => Math.max(recipe.minimumQuantity, value - 1))}
                >−</GameAppButton>
                <div><span>Batch</span><strong>{quantity}</strong></div>
                <GameAppButton
                  type="button"
                  className="furnace-quantity-max"
                  disabled={materialCapacity < recipe.minimumQuantity || quantity === materialCapacity || props.busy}
                  onClick={() => setQuantity(materialCapacity)}
                >Max</GameAppButton>
                <GameAppButton
                  type="button"
                  aria-label={`Increase ${recipe.outputDisplayName} quantity`}
                  disabled={quantity >= recipe.maximumQuantity || props.busy}
                  onClick={() => setQuantity((value) => Math.min(recipe.maximumQuantity, value + 1))}
                >+</GameAppButton>
              </div>
              <section className="furnace-materials" aria-labelledby="furnace-materials-title">
                <GameAppSectionHeader title="Materials" titleId="furnace-materials-title" />
                <MaterialChips label={`${recipe.displayName} materials`} materials={inputs.map((input) => ({
                  itemId: input.itemId,
                  quantity: input.quantity,
                  name: input.displayName,
                  have: spendable.get(input.itemId) ?? 0
                }))} />
              </section>
              <dl className="game-app-stats furnace-recipe-facts">
                <div><dt>Time</dt><dd>{formatDuration(recipe.durationMs)} total</dd></div>
                <div><dt>Queue space</dt><dd>{queueRemaining} of {props.state.queueCapacity}</dd></div>
              </dl>
            </div>
          </GameAppCard>
        </>}
      </div>
    </GameAppShell>
    {guard ? <HighGradeGuardPrompt
      message={guard}
      onChooseAnother={() => setGuard(null)}
      onUseIt={() => {
        setGuard(null);
        if (props.onStart(recipeId, quantity, { confirmHighGrade: true })) setView("queue");
      }}
    /> : null}
  </>;
}

function TanneryQueueJob(props: Readonly<{
  job: TanneryStateSnapshot["jobs"][number];
  index: number;
  clock: number;
}>): React.JSX.Element {
  const recipe = requireTanneryRecipe(props.job.recipeId);
  const queued = Date.parse(props.job.startedAt) > props.clock;
  const nextRemaining = !props.job.productionFinished
    ? Math.max(0, Date.parse(props.job.completesAt) - props.clock)
    : null;
  const progress = !props.job.productionFinished && !queued
    ? Math.min(1, Math.max(0, 1 - (Date.parse(props.job.completesAt) - props.clock) / recipe.durationMs))
    : props.job.productionFinished ? 1 : 0;
  const status = props.job.productionFinished ? "Complete" : queued ? "Queued" : "In progress";
  return <article className="furnace-queue-job" data-status={status.toLowerCase().replace(" ", "-")}>
    <div className="furnace-output-summary">
      <ItemArtwork itemId={props.job.outputItemId} label={props.job.outputDisplayName} />
      <div>
        <span>{!queued && !props.job.productionFinished
          ? "Active work order"
          : `Queue position ${props.index + 1}`}</span>
        <strong>{formatOutputQuantity(props.job.outputQuantity, props.job.outputDisplayName)}</strong>
        <small>{status}</small>
      </div>
    </div>
    <div
      className="game-app-progress furnace-progress"
      role="progressbar"
      aria-label={`Progress toward ${props.job.outputDisplayName}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    ><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
    <div className="furnace-job-state">
      <strong>{props.job.readyQuantity > 0
        ? `${props.job.readyQuantity} ready to collect`
        : nextRemaining !== null
          ? `${queued ? "Begins after earlier work · ready" : "Next ready"} in ${formatRemaining(nextRemaining)}`
          : "Production complete"}</strong>
      <small>{queued ? "Materials reserved. The Tannery will start this automatically." : "The Tannery continues while you travel."}</small>
    </div>
  </article>;
}

function formatOutputQuantity(quantity: number, outputDisplayName: string): string {
  return `${quantity} ${outputDisplayName}${quantity === 1 ? "" : "s"}`;
}

function formatRemaining(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)} seconds`;
  const minutes = ms / 60_000;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes} minutes`;
  return remainder === 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours}h ${remainder}m`;
}
