import {
  FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT,
  FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT,
  FURNACE_GLIMMER_OIL_ITEM_ID,
  FURNACE_GLIMMER_OIL_MAX_QUANTITY,
  startableFurnaceRecipes,
  furnaceCategoryInputs,
  furnaceRecipeInputs,
  highGradeGuardMessage,
  FURNACE_BREAKDOWNS,
  FURNACE_BREAKDOWN_MAX_QUANTITY,
  INVENTORY_CATALOG,
  type InventoryProtectionSnapshot,
  metallurgyIronSuccessChance,
  slagRecoveryCostForMetallurgyRank,
  requireFurnaceRecipe,
  type FurnaceRecipeId,
  type FurnaceStateSnapshot,
  type FurnaceWorldSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameAppActionBar, GameAppButton, GameAppCard, GameAppSectionHeader, GameAppShell } from "./GameAppShell.js";
import { CurrencyGlyph } from "./InventoryCarryList.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChip, MaterialChips, materialChipLabel, materialChipState } from "./MaterialRequirements.js";
import {
  BreakdownSection,
  CategoryInputChips,
  GradePip,
  HighGradeGuardPrompt,
  spendableCounts,
  useCategoryPreview,
  useSequentialStarts,
  type BreakdownRecipe
} from "./MaterialCategoryUi.js";
import type { StationStartOptions } from "../client/domains/manorClient.js";

/** Furnace breakdown is instant: the recipe id sent is the input item id. */
const FURNACE_BREAKDOWN_RECIPES: readonly BreakdownRecipe[] = FURNACE_BREAKDOWNS.map((entry) => ({
  recipeId: entry.inputItemId,
  inputItemId: entry.inputItemId,
  outputItemId: entry.outputItemId,
  outputDisplayName: INVENTORY_CATALOG[entry.outputItemId]?.displayName ?? entry.outputItemId,
  outputPerInput: entry.outputPerInput,
  maximumQuantity: FURNACE_BREAKDOWN_MAX_QUANTITY,
  breakdownGrade: entry.grade
}));

const GLIMMER_OIL_TAB = "glimmer_oil" as const;
const GLIMMER_OIL_PRESETS = [1, 5, 20] as const;

export function FurnaceActionPrompt(props: Readonly<{
  furnace: FurnaceWorldSnapshot;
  state: FurnaceStateSnapshot | null;
  ownPlayerId: string;
  connected: boolean;
  feedback: string | null;
  collecting: boolean;
  onSmelt(): void;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const owned = props.furnace.ownerPlayerId === props.ownPlayerId;
  const disabledReason = !owned
    ? `Owned by ${props.furnace.ownerUsername}.`
    : props.connected ? null : "Cannot use a Furnace while disconnected.";
  const readyJob = props.state?.furnace.furnaceId === props.furnace.furnaceId &&
    props.state.jobs.find((job) => job.readyQuantity > 0);
  const readyQuantity = props.state?.jobs.reduce((total, job) => total + job.readyQuantity, 0) ?? 0;
  return <GameActionPrompt
    title="Furnace"
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
        key: "smelt",
        label: "Use",
        enabled: disabledReason === null && !props.collecting,
        disabledReason,
        tone: readyJob ? "secondary" as const : "primary" as const,
        onSelect: () => props.onSmelt()
      }
    ]}
    onCancel={props.onClose}
  />;
}

export function FurnacePrompt(props: Readonly<{
  state: FurnaceStateSnapshot | null;
  inventory: PlayerInventorySnapshot;
  feedback: string | null;
  busy: boolean;
  layout?: "desktop" | "phone";
  /** Account Glimmer balance (decimal string); null while unavailable. */
  glimmerBalance?: string | null;
  protection?: InventoryProtectionSnapshot | null;
  onStart(recipeId: FurnaceRecipeId | string, quantity: number, options?: StationStartOptions): boolean;
  onRefineGlimmerOil?(quantity: number): boolean;
  onCollect(): void;
  onClose(): void;
}>): React.JSX.Element {
  const [recipeId, setRecipeId] = useState<FurnaceRecipeId>("iron_bar");
  const [refiningOil, setRefiningOil] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [oilQuantity, setOilQuantity] = useState(1);
  const [clock, setClock] = useState(Date.now());
  const [view, setView] = useState<"recipes" | "queue">("recipes");
  const [guard, setGuard] = useState<Readonly<{ message: string; send(): void }> | null>(null);
  const [breakdownId, setBreakdownId] = useState<string | null>(null);
  const [breakdownQuantity, setBreakdownQuantity] = useState(1);
  const recipe = requireFurnaceRecipe(recipeId);
  const spendable = spendableCounts(props.inventory, props.protection);
  const startBulk = useSequentialStarts(props.busy, (bulkId, bulkQuantity) => props.onStart(bulkId, bulkQuantity));
  const jobs = props.state?.jobs ?? [];
  const queueRemaining = Math.max(0, (props.state?.queueCapacity ?? 5) - (props.state?.occupiedSlots ?? 0));
  const metallurgyRank = props.state?.metallurgyRank ?? 0;
  const recoveryCost = slagRecoveryCostForMetallurgyRank(metallurgyRank);
  const inputs = furnaceRecipeInputs(recipeId, quantity, { metallurgyRank });
  const unitInputs = furnaceRecipeInputs(recipeId, 1, { metallurgyRank });
  const categoryInputs = furnaceCategoryInputs(recipeId, quantity);
  const categoryPreview = useCategoryPreview(inputs, categoryInputs, spendable);
  const professionLocked = (recipeId === "slag_recovery" && recoveryCost === null) ||
    metallurgyRank < recipe.minimumMetallurgyRank;
  const affordable = !professionLocked && quantity <= queueRemaining && inputs.every(
    (input) => (spendable.get(input.itemId) ?? 0) >= input.quantity
  ) && (categoryInputs.length === 0 || categoryPreview.ready);
  const materialCapacity = Math.min(
    recipe.maximumQuantity,
    queueRemaining,
    ...unitInputs.map((input) => Math.floor((props.inventory.totals[input.itemId] ?? 0) / input.quantity))
  );
  const readyQuantity = jobs.reduce((total, candidate) => total + candidate.readyQuantity, 0);
  const nextCompletion = jobs.find((candidate) => candidate.nextCompletesAt)?.nextCompletesAt ?? null;
  const crudeOilHave = props.inventory.totals.crude_oil ?? 0;
  const crudeOilNeed = oilQuantity * FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT;
  const glimmerHave = props.glimmerBalance === null || props.glimmerBalance === undefined
    ? null
    : Number(BigInt(props.glimmerBalance) > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : props.glimmerBalance);
  const glimmerNeed = oilQuantity * FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT;
  const oilCapacity = Math.min(
    FURNACE_GLIMMER_OIL_MAX_QUANTITY,
    Math.floor(crudeOilHave / FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT),
    Math.floor((glimmerHave ?? 0) / FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT)
  );
  const oilBlockedReason = !props.onRefineGlimmerOil
    ? "Refining is unavailable"
    : glimmerHave === null
      ? "Glimmer balance unavailable"
      : glimmerHave < glimmerNeed
        ? `Need ${(glimmerNeed - glimmerHave).toLocaleString()} more Glimmer`
        : crudeOilHave < crudeOilNeed
          ? `Need ${(crudeOilNeed - crudeOilHave).toLocaleString()} more Crude Oil`
          : null;

  useEffect(() => {
    const maximum = Math.max(recipe.minimumQuantity, Math.min(recipe.maximumQuantity, queueRemaining));
    setQuantity((current) => Math.min(maximum, Math.max(recipe.minimumQuantity, current)));
  }, [queueRemaining, recipe.maximumQuantity, recipe.minimumQuantity]);
  useEffect(() => {
    if (!nextCompletion) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nextCompletion]);

  const outputLabel = formatOutputQuantity(quantity, recipe.outputDisplayName);
  const actionStatus = view === "queue"
    ? readyQuantity > 0
      ? `${readyQuantity} ready to collect`
      : jobs.length > 0 ? `${props.state?.occupiedSlots ?? 0} of ${props.state?.queueCapacity ?? 5} slots filled` : "Queue is empty"
    : refiningOil
      ? oilBlockedReason ?? "Instant · uses no queue slot"
    : professionLocked
      ? "Requires Metallurgy Rank 2"
      : queueRemaining === 0 ? "Queue is full"
      : `${formatDuration(recipe.durationMs)}${recipe.completionMode === "batch" ? " total" : " per item"}`;

  return <>
    <GameAppShell
      open
      title="Furnace"
      closeLabel="Close Furnace"
      className="furnace-app"
      layout={props.layout ?? "desktop"}
      phoneBackLabel={view === "queue" ? "Back to Furnace" : "Back to World"}
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
        >Collect {readyQuantity} {readyQuantity === 1 ? "item" : "items"}</GameAppButton> : refiningOil ? <GameAppButton
          variant="primary"
          disabled={props.busy || !props.state || oilBlockedReason !== null}
          onClick={() => props.onRefineGlimmerOil?.(oilQuantity)}
        >Refine {oilQuantity} Glimmer Oil</GameAppButton> : <GameAppButton
          variant="primary"
          disabled={props.busy || !props.state || !affordable || queueRemaining === 0 || professionLocked}
          onClick={() => {
            const send = (confirmHighGrade: boolean) => {
              const options: StationStartOptions = categoryInputs.length === 0 ? {} : {
                categoryPicks: categoryPreview.picks.map((list) => list.map((pick) => ({ ...pick }))),
                ...(confirmHighGrade ? { confirmHighGrade: true } : {})
              };
              const started = categoryInputs.length === 0
                ? props.onStart(recipeId, quantity)
                : props.onStart(recipeId, quantity, options);
              if (started) setView("queue");
            };
            if (categoryPreview.guardMessage && categoryInputs.length > 0) {
              setGuard({ message: categoryPreview.guardMessage, send: () => send(true) });
              return;
            }
            send(false);
          }}
        >Queue {outputLabel}</GameAppButton>}
      </GameAppActionBar>}
    >
      <div className="furnace-workspace">
        {props.feedback ? <p className="furnace-status-copy" role="status">{props.feedback}</p> : null}
        {!props.state ? <GameAppCard title="Preparing Furnace" badge="Loading">
          <p className="furnace-empty-copy">Checking the station and your materials…</p>
        </GameAppCard> : view === "queue" ? <GameAppCard
          title="Production queue"
          badge={`${props.state.occupiedSlots} / ${props.state.queueCapacity} slots`}
        >
          {jobs.length > 0 ? <div className="furnace-queue">
            {jobs.map((candidate, index) => <FurnaceQueueJob
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
          <nav className="furnace-recipe-tabs" aria-label="Furnace recipes">
            {startableFurnaceRecipes().map((candidate) => <button
              key={candidate.recipeId}
              type="button"
              aria-pressed={!refiningOil && candidate.recipeId === recipeId}
              disabled={props.busy}
              onClick={() => {
                setRefiningOil(false);
                setRecipeId(candidate.recipeId);
              }}
            >
              <ItemArtwork itemId={candidate.outputItemId} label={candidate.outputDisplayName} />
              <span>
                <strong>{candidate.outputDisplayName}</strong>
                <small>{formatDuration(candidate.durationMs)}</small>
              </span>
            </button>)}
            <button
              key={GLIMMER_OIL_TAB}
              type="button"
              aria-pressed={refiningOil}
              disabled={props.busy}
              onClick={() => setRefiningOil(true)}
            >
              <ItemArtwork itemId={FURNACE_GLIMMER_OIL_ITEM_ID} label="Glimmer Oil" />
              <span>
                <strong>Glimmer Oil</strong>
                <small>{formatDuration(0)}</small>
              </span>
            </button>
          </nav>
          <BreakdownSection
            recipes={FURNACE_BREAKDOWN_RECIPES}
            spendable={spendable}
            selectedRecipeId={breakdownId}
            busy={props.busy}
            freeSlots={FURNACE_BREAKDOWN_RECIPES.length * 10}
            onSelect={(id) => { setBreakdownId(id); setBreakdownQuantity(1); }}
            onBreakDownAll={startBulk}
          />
          {breakdownId ? <FurnaceBreakdownCard
            recipe={FURNACE_BREAKDOWN_RECIPES.find((entry) => entry.recipeId === breakdownId)!}
            held={spendable.get(breakdownId) ?? 0}
            quantity={breakdownQuantity}
            busy={props.busy}
            onQuantity={setBreakdownQuantity}
            onBreakDown={() => {
              const send = (confirmHighGrade: boolean) => props.onStart(breakdownId, breakdownQuantity, confirmHighGrade ? { confirmHighGrade: true } : {});
              const entry = FURNACE_BREAKDOWN_RECIPES.find((candidate) => candidate.recipeId === breakdownId)!;
              if ((entry.breakdownGrade ?? 0) >= 4) {
                setGuard({ message: highGradeGuardMessage([{ itemId: breakdownId, quantity: breakdownQuantity }]), send: () => { send(true); } });
                return;
              }
              send(false);
            }}
          /> : null}
          {refiningOil ? <GameAppCard
            title="Refine Glimmer Oil"
            status={<CraftStatusMark ready={oilBlockedReason === null} verb="craft" />}
          >
            <div className="furnace-recipe-detail">
              <div className="furnace-output-summary">
                <ItemArtwork itemId={FURNACE_GLIMMER_OIL_ITEM_ID} label="Glimmer Oil" />
                <div>
                  <span>Output</span>
                  <strong>{oilQuantity} Glimmer Oil</strong>
                  <small>Refined instantly; uses no queue slot</small>
                </div>
              </div>
              <p className="furnace-status-copy">
                Each Glimmer Oil takes {FURNACE_GLIMMER_OIL_CRUDE_OIL_PER_UNIT} Crude Oil and {FURNACE_GLIMMER_OIL_GLIMMER_PER_UNIT} Glimmer. Dungeon torches burn Glimmer Oil.
              </p>
              <div className="furnace-quantity" aria-label="Glimmer Oil quantity">
                <GameAppButton
                  type="button"
                  aria-label="Decrease Glimmer Oil quantity"
                  disabled={oilQuantity <= 1 || props.busy}
                  onClick={() => setOilQuantity((value) => Math.max(1, value - 1))}
                >−</GameAppButton>
                <div><span>Amount</span><strong>{oilQuantity}</strong></div>
                <GameAppButton
                  type="button"
                  className="furnace-quantity-max"
                  disabled={oilCapacity < 1 || oilQuantity === oilCapacity || props.busy}
                  onClick={() => setOilQuantity(oilCapacity)}
                >Max</GameAppButton>
                <GameAppButton
                  type="button"
                  aria-label="Increase Glimmer Oil quantity"
                  disabled={oilQuantity >= FURNACE_GLIMMER_OIL_MAX_QUANTITY || props.busy}
                  onClick={() => setOilQuantity((value) => Math.min(FURNACE_GLIMMER_OIL_MAX_QUANTITY, value + 1))}
                >+</GameAppButton>
              </div>
              <div className="furnace-quantity-presets" role="group" aria-label="Glimmer Oil amount presets">
                {GLIMMER_OIL_PRESETS.map((preset) => <GameAppButton
                  key={preset}
                  type="button"
                  aria-pressed={oilQuantity === preset}
                  disabled={props.busy}
                  onClick={() => setOilQuantity(preset)}
                >{preset}</GameAppButton>)}
              </div>
              <section className="furnace-materials" aria-labelledby="furnace-oil-materials-title">
                <GameAppSectionHeader title="Cost" titleId="furnace-oil-materials-title" />
                <div className="material-chip-list" role="group" aria-label="Glimmer Oil cost">
                  <MaterialChip itemId="crude_oil" name="Crude Oil" need={crudeOilNeed} have={crudeOilHave} />
                  <span
                    className="phone-build-material-requirement material-chip furnace-glimmer-chip"
                    data-state={materialChipState(glimmerNeed, glimmerHave)}
                    role="img"
                    aria-label={materialChipLabel("Glimmer", glimmerNeed, glimmerHave)}
                  >
                    <CurrencyGlyph kind="glimmer" />
                    <b>{materialChipState(glimmerNeed, glimmerHave) === "short"
                      ? `${(glimmerHave ?? 0).toLocaleString()}/${glimmerNeed.toLocaleString()}`
                      : glimmerNeed.toLocaleString()}</b>
                  </span>
                </div>
              </section>
              <dl className="game-app-stats furnace-recipe-facts">
                <div><dt>Glimmer balance</dt><dd>{glimmerHave === null ? "Unavailable" : glimmerHave.toLocaleString()}</dd></div>
                <div><dt>Crude Oil</dt><dd>{crudeOilHave.toLocaleString()}</dd></div>
                <div><dt>Time</dt><dd>Instant</dd></div>
              </dl>
            </div>
          </GameAppCard> : <GameAppCard title={recipe.displayName} status={<CraftStatusMark ready={affordable} verb="craft" />}>
            <div className="furnace-recipe-detail">
              <div className="furnace-output-summary">
                <ItemArtwork itemId={recipe.outputItemId} label={recipe.outputDisplayName} />
                <div>
                  <span>Output</span>
                  <strong>{outputLabel}</strong>
                  <small>{recipe.completionMode === "batch" ? "Completed as one batch" : "Completed one at a time"}</small>
                </div>
              </div>
              {recipeId === "iron_bar" ? <p className="furnace-status-copy">
                Metallurgy Rank {metallurgyRank}: {Math.round(metallurgyIronSuccessChance(metallurgyRank) * 100)}% success per Iron Bar. Failed attempts produce Slag.
              </p> : null}
              {recipeId === "slag_recovery" ? <p className="furnace-status-copy">
                Requires Metallurgy Rank 2. Current recovery cost: {recoveryCost ?? 5} Slag per Iron Bar; no Wood or Metallurgy XP required.
              </p> : null}
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
                  disabled={quantity >= Math.min(recipe.maximumQuantity, queueRemaining) || props.busy}
                  onClick={() => setQuantity((value) => Math.min(recipe.maximumQuantity, queueRemaining, value + 1))}
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
                <CategoryInputChips
                  inputs={categoryInputs}
                  preview={categoryPreview}
                  spendable={spendable}
                  preferred={categoryPreview.preferred}
                  onPrefer={categoryPreview.prefer}
                />
              </section>
              <dl className="game-app-stats furnace-recipe-facts">
                <div><dt>Time</dt><dd>{formatDuration(recipe.durationMs)}{recipe.completionMode === "sequential" ? " each" : " total"}</dd></div>
                {recipeId === "slag_recovery" ? <div><dt>Rank gate</dt><dd>Metallurgy Rank 2+</dd></div> : null}
                <div><dt>Queue space</dt><dd>{queueRemaining} of {props.state.queueCapacity}</dd></div>
              </dl>
            </div>
          </GameAppCard>}
        </>}
      </div>
    </GameAppShell>
    {guard ? <HighGradeGuardPrompt
      message={guard.message}
      onChooseAnother={() => setGuard(null)}
      onUseIt={() => { const pending = guard; setGuard(null); pending.send(); }}
    /> : null}
  </>;
}

/** Instant breakdown at the Furnace (no queue), like Glimmer Oil. */
function FurnaceBreakdownCard(props: Readonly<{
  recipe: BreakdownRecipe;
  held: number;
  quantity: number;
  busy: boolean;
  onQuantity(quantity: number): void;
  onBreakDown(): void;
}>): React.JSX.Element {
  const name = INVENTORY_CATALOG[props.recipe.inputItemId]?.displayName ?? props.recipe.inputItemId;
  const maximum = Math.min(props.recipe.maximumQuantity, props.held);
  return <GameAppCard title={`Break down ${name}`} status={<CraftStatusMark ready={props.held >= props.quantity} verb="craft" />}>
    <div className="furnace-recipe-detail">
      <div className="furnace-output-summary">
        <ItemArtwork itemId={props.recipe.outputItemId} label={props.recipe.outputDisplayName} />
        <div>
          <span>Output · instant · cannot be undone</span>
          <strong>{props.quantity * props.recipe.outputPerInput} {props.recipe.outputDisplayName}</strong>
          <small>{props.quantity} {name} <GradePip itemId={props.recipe.inputItemId} /></small>
        </div>
      </div>
      <div className="furnace-quantity" aria-label={`${name} quantity`}>
        <GameAppButton type="button" aria-label={`Decrease ${name} quantity`} disabled={props.quantity <= 1 || props.busy} onClick={() => props.onQuantity(props.quantity - 1)}>−</GameAppButton>
        <div><span>Batch</span><strong>{props.quantity}</strong></div>
        <GameAppButton type="button" className="furnace-quantity-max" disabled={maximum < 1 || props.quantity === maximum || props.busy} onClick={() => props.onQuantity(maximum)}>Max</GameAppButton>
        <GameAppButton type="button" aria-label={`Increase ${name} quantity`} disabled={props.quantity >= maximum || props.busy} onClick={() => props.onQuantity(props.quantity + 1)}>+</GameAppButton>
      </div>
      <GameAppButton variant="primary" disabled={props.busy || props.held < props.quantity} onClick={props.onBreakDown}>Break down {props.quantity}</GameAppButton>
    </div>
  </GameAppCard>;
}

function FurnaceQueueJob(props: Readonly<{
  job: FurnaceStateSnapshot["jobs"][number];
  index: number;
  clock: number;
}>): React.JSX.Element {
  const recipe = requireFurnaceRecipe(props.job.recipeId);
  const queued = Date.parse(props.job.startedAt) > props.clock;
  const nextRemaining = props.job.nextCompletesAt
    ? Math.max(0, Date.parse(props.job.nextCompletesAt) - props.clock)
    : null;
  const progress = props.job.nextCompletesAt && !queued
    ? Math.min(1, Math.max(0, 1 - (Date.parse(props.job.nextCompletesAt) - props.clock) / recipe.durationMs))
    : props.job.productionFinished ? 1 : 0;
  const status = props.job.productionFinished ? "Complete" : queued ? "Queued" : "In progress";
  return <article className="furnace-queue-job" data-status={status.toLowerCase().replace(" ", "-")}>
    <div className="furnace-output-summary">
      <ItemArtwork itemId={props.job.outputItemId} label={props.job.outputDisplayName} />
      <div>
        <span>{!queued && !props.job.productionFinished
          ? "Active work order"
          : `Queue position ${props.index + 1}`}</span>
        <strong>{formatOutputQuantity(props.job.requestedQuantity, props.job.outputDisplayName)}</strong>
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
        ? props.job.readySuccessQuantity !== undefined && props.job.readyFailureQuantity !== undefined &&
          (props.job.readySuccessQuantity > 0 || props.job.readyFailureQuantity > 0)
          ? `${props.job.readySuccessQuantity} Iron Bar${props.job.readySuccessQuantity === 1 ? "" : "s"} + ${props.job.readyFailureQuantity} Slag ready to collect`
          : `${props.job.readyQuantity} ready to collect`
        : nextRemaining !== null
          ? `${queued ? "Begins after earlier work · ready" : "Next ready"} in ${formatRemaining(nextRemaining)}`
          : "Production complete"}</strong>
      <small>{queued ? "Materials reserved. The Furnace will start this automatically." : "The Furnace continues while you travel."}</small>
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
  if (ms === 0) return "Instant";
  const minutes = ms / 60_000;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes} minutes`;
  return remainder === 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours}h ${remainder}m`;
}
