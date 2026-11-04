import {
  EQUIPMENT_CRAFT_RECIPES,
  equipmentCraftTradeGate,
  EQUIPMENT_SWAG_CRAFT_RECIPES,
  activeEquipmentLimitedSales,
  emptyInventoryTotals,
  isCarriedEquipmentLocation,
  requireEquipmentDefinition,
  resolveEquipmentItemDerivedStats,
  equipmentRepairCostForFamily,
  EQUIPMENT_MAX_CONDITION,
  REPAIR_KIT_CRAFT_CATEGORY_INPUTS,
  REPAIR_KIT_CRAFT_COSTS,
  type EquipmentRepairCost,
  TRADE_SKILL_GATES,
  tradeSkillGateMessage,
  tradeSkillGateMet,
  type EquipmentInstanceV2,
  type EquipmentCraftRecipe,
  type EquipmentSwagCraftRecipe,
  type ActiveEquipmentLimitedSale,
  type EquipmentItemDerivedStats,
  type EquipmentSnapshotV2,
  type ManorOccupantAccessSource,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { categoryNeeds, spendableCounts } from "./MaterialCategoryUi.js";
import { DestinationShell } from "./DestinationShell.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { GameAppButton, GameAppTabs } from "./GameAppShell.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChips } from "./MaterialRequirements.js";

export type SmithingStationUpgradeFeedback =
  | Readonly<{
      kind: "success";
      requestId: string;
      instanceId: string;
      displayName: string;
      levelAfter: number;
    }>
  | Readonly<{
      kind: "error";
      requestId: string;
      instanceId?: string;
      definitionId?: string;
      code: string;
      message: string;
    }>
  | Readonly<{
      kind: "acquisition";
      requestId: string;
      definitionId: string;
      message: string;
    }>
  | Readonly<{
      kind: "repair";
      requestId: string;
      instanceId: string;
      displayName: string;
      conditionAfter: number;
      message: string;
    }>
  | Readonly<{
      kind: "repair-kit";
      requestId: string;
      message: string;
    }>;

type Props = {
  open: boolean;
  /** Swag weapons sold shop-only: their recipe is hidden (the server refuses the craft too). */
  hiddenDefinitionIds?: readonly string[];
  equipment: EquipmentSnapshotV2 | null;
  inventory?: PlayerInventorySnapshot;
  walletGold: string | null;
  online: boolean;
  busy: boolean;
  feedback: SmithingStationUpgradeFeedback | null;
  layout: "desktop" | "phone";
  manorSession: Readonly<{
    sessionId: string;
    accessSource: ManorOccupantAccessSource;
  }> | null;
  onUpgrade(item: EquipmentInstanceV2, manorSessionId: string): string | null;
  onCraft?(recipe: EquipmentCraftRecipe, manorSessionId: string): string | null;
  onCraftRepairKit?(manorSessionId: string): string | null;
  onRepair?(item: EquipmentInstanceV2, manorSessionId: string): string | null;
  /** Blacksmithing rank; repairing needs rank 1. */
  blacksmithingRank?: number;
  /** Leatherworking rank; crafting a Sling needs rank 1 and Leather Armor rank 3. */
  leatherworkingRank?: number;
  onPurchase?(sale: ActiveEquipmentLimitedSale, manorSessionId: string): string | null;
  onRetryData(): void;
  onClose(): void;
  /** World Knowledge ranks; skill-gated recipes stay hidden until the rank is learned. */
  worldKnowledgeRanks?: Readonly<Partial<Record<string, number>>>;
};

export function SmithingStationPanel({
  open,
  hiddenDefinitionIds = [],
  equipment,
  inventory = EMPTY_INVENTORY,
  walletGold,
  online,
  busy,
  feedback,
  layout,
  manorSession,
  onUpgrade,
  onCraft = () => null,
  onCraftRepairKit = () => null,
  onRepair = () => null,
  blacksmithingRank = 0,
  leatherworkingRank = 0,
  onPurchase = () => null,
  onRetryData,
  onClose,
  worldKnowledgeRanks = {}
}: Props): React.JSX.Element | null {
  const title = "Smithing Station";
  const [activeTab, setActiveTab] = useState<"upgrade" | "craft" | "repair" | "limited">("upgrade");
  const cachedEquipmentRef = useRef<EquipmentSnapshotV2 | null>(null);
  if (!open) cachedEquipmentRef.current = null;
  else if (equipment) cachedEquipmentRef.current = equipment;
  const visibleEquipment = equipment ?? cachedEquipmentRef.current;
  const items = useMemo(
    () => visibleEquipment?.instances.filter((item) =>
      isCarriedEquipmentLocation(item.location)
    ) ?? [],
    [visibleEquipment]
  );
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [missingSelection, setMissingSelection] = useState<string | null>(null);
  const [confirmationInstanceId, setConfirmationInstanceId] =
    useState<string | null>(null);
  const openRef = useRef(false);
  const facilityIdRef = useRef<string | null>(null);
  const submissionGuardRef = useRef<string | null>(null);
  const sawBusyRef = useRef(false);
  const authorityId = manorSession?.sessionId ?? null;

  useLayoutEffect(() => {
    if (!open) {
      openRef.current = false;
      return;
    }
    const entering = !openRef.current || facilityIdRef.current !== authorityId;
    openRef.current = true;
    facilityIdRef.current = authorityId;
    if (entering) {
      setSelectedInstanceId(items[0]?.instanceId ?? null);
      setMissingSelection(null);
      setConfirmationInstanceId(null);
      submissionGuardRef.current = null;
      sawBusyRef.current = false;
      return;
    }
    if (
      equipment &&
      selectedInstanceId &&
      !items.some((item) => item.instanceId === selectedInstanceId)
    ) {
      setSelectedInstanceId(null);
      setConfirmationInstanceId(null);
      setMissingSelection(
        "The selected item is no longer in your Inventory or equipped."
      );
    }
  }, [authorityId, equipment, items, open, selectedInstanceId]);

  useEffect(() => {
    if (busy) {
      sawBusyRef.current = true;
      return;
    }
    if (sawBusyRef.current || feedback) {
      sawBusyRef.current = false;
      submissionGuardRef.current = null;
    }
  }, [busy, feedback]);

  const selectedItem = items.find(
    (item) => item.instanceId === selectedInstanceId
  ) ?? null;
  const selectedEligibility = selectedItem
    ? upgradeEligibility({
        item: selectedItem,
        walletGold,
        online
      })
    : null;
  const nextStats = selectedItem && selectedItem.nextUpgradeLevel !== null &&
      visibleEquipment
    ? resolveNextStats(selectedItem, visibleEquipment)
    : null;
  const confirmationItem = items.find(
    (item) => item.instanceId === confirmationInstanceId
  ) ?? null;

  const confirmUpgrade = (): void => {
    if (!confirmationItem || !authorityId || submissionGuardRef.current) return;
    const eligibility = upgradeEligibility({
      item: confirmationItem,
      walletGold,
      online
    });
    if (!eligibility.allowed) {
      setConfirmationInstanceId(null);
      return;
    }
    const requestId = onUpgrade(confirmationItem, authorityId);
    if (!requestId) return;
    submissionGuardRef.current = requestId;
    setConfirmationInstanceId(null);
  };

  return (
    <>
      <DestinationShell
        open={open}
        title={title}
        eyebrow={manorSession
          ? manorSession.accessSource === "OWNER"
            ? "Your manor"
            : "Visited manor"
          : "Manor Smithing Station"}
        closeLabel={`Close ${title}`}
        className="smithing-station-panel"
        layout={layout}
        phoneBackLabel="Back to World"
        phoneOnReturnToGame={onClose}
        onClose={onClose}
      >
        <div className="smithing-station-workspace">
          <GameAppTabs
            ariaLabel="Smithing Station sections"
            activeTab={activeTab}
            tabs={[
              { id: "upgrade", label: "Upgrade" },
              { id: "craft", label: "Craft" },
              { id: "repair", label: "Repair" },
              { id: "limited", label: "Limited" }
            ]}
            onChange={(id) => setActiveTab(id as typeof activeTab)}
          />
          {!manorSession ? (
            <FacilityState
              title="Smithing Station unavailable"
              message="Upgrade equipment at a Smithing Station inside a manor."
              retry={online ? onRetryData : null}
            />
          ) : !visibleEquipment ? (
            <FacilityState
              title="Loading equipment"
              message={online
                ? "Waiting for the authoritative equipment snapshot."
                : "Reconnect to load your equipment."}
              retry={online ? onRetryData : null}
            />
          ) : activeTab === "craft" ? (
            <EquipmentCraftingView
              inventory={inventory}
              online={online}
              busy={busy}
              feedback={feedback}
              manorSessionId={authorityId!}
              onCraft={onCraft}
              onCraftRepairKit={onCraftRepairKit}
              worldKnowledgeRanks={worldKnowledgeRanks}
              leatherworkingRank={leatherworkingRank}
              hiddenDefinitionIds={hiddenDefinitionIds}
            />
          ) : activeTab === "repair" ? (
            <EquipmentRepairView
              items={items}
              inventory={inventory}
              online={online}
              busy={busy}
              feedback={feedback}
              manorSessionId={authorityId!}
              selectedItem={selectedItem}
              selectedInstanceId={selectedInstanceId}
              onSelect={(instanceId) => {
                setSelectedInstanceId(instanceId);
                setMissingSelection(null);
              }}
              onRepair={onRepair}
              blacksmithingRank={blacksmithingRank}
            />
          ) : activeTab === "limited" ? (
            <LimitedEquipmentView
              walletGold={walletGold}
              online={online}
              busy={busy}
              feedback={feedback}
              manorSessionId={authorityId!}
              onPurchase={onPurchase}
            />
          ) : (
            <div className="smithing-station-layout">
              <section className="smithing-station-picker" aria-label={`${title} equipment`}>
                <header className="smithing-station-section-heading">
                  <div>
                    <span>Owned equipment</span>
                    <strong>
                      {items.length} equipment items
                    </strong>
                  </div>
                  <small>Choose one item to review.</small>
                </header>
                {items.length === 0 ? (
                  <div className="smithing-station-empty">
                    <strong>
                      No equipment available
                    </strong>
                    <span>
                      Applicable equipment in your Inventory or equipped loadout appears here.
                    </span>
                  </div>
                ) : (
                  <div className="game-app-rows smithing-station-equipment-list">
                    {items.map((item) => {
                      const eligibility = upgradeEligibility({
                        item,
                        walletGold,
                        online
                      });
                      const selected = item.instanceId === selectedInstanceId;
                      return (
                        <GameAppButton
                          key={item.instanceId}
                          className={`game-app-row smithing-station-equipment-row${selected ? " selected" : ""}`}
                          aria-pressed={selected}
                          onClick={() => {
                            setSelectedInstanceId(item.instanceId);
                            setMissingSelection(null);
                            setConfirmationInstanceId(null);
                          }}
                        >
                          <ItemArtwork
                            itemId={item.definitionId}
                            category={item.category}
                            label={item.displayName}
                          />
                          <span className="smithing-station-item-copy">
                            <strong>{item.displayName}</strong>
                            <small>
                              {formatEquipmentType(item)} - Level {item.itemLevel}
                              {isRepairable(item) ? ` - Condition ${item.condition ?? EQUIPMENT_MAX_CONDITION}/${EQUIPMENT_MAX_CONDITION}` : ""}
                              {item.location === "equipped" ? " - Equipped" : ""}
                            </small>
                          </span>
                          {eligibility.allowed || eligibility.label === "Insufficient Gold"
                            ? <span className="game-app-card-status smithing-station-item-status"><CraftStatusMark ready={eligibility.allowed} verb="craft" /></span>
                            : <span className={`game-app-badge smithing-station-item-status ${eligibility.tone}`}>
                              {eligibility.label}
                            </span>}
                        </GameAppButton>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="smithing-station-detail" aria-live="polite">
                {feedback ? (
                  <div className={`smithing-station-feedback ${feedback.kind}`} role="status">
                    <strong>{feedback.kind === "success"
                      ? `${feedback.displayName} upgraded to level ${feedback.levelAfter}.`
                      : feedback.message}</strong>
                    {feedback.kind === "error" ? <small>{feedback.code}</small> : null}
                  </div>
                ) : null}
                {missingSelection ? (
                  <div className="smithing-station-feedback error" role="status">
                    <strong>{missingSelection}</strong>
                    <small>Select another item to continue.</small>
                  </div>
                ) : null}
                {!selectedItem ? (
                  <div className="smithing-station-empty smithing-station-empty-detail">
                    <strong>Select equipment</strong>
                    <span>Review its level, stat change, and full upgrade cost here.</span>
                  </div>
                ) : (
                  <>
                    <header className="smithing-station-selected-header">
                      <div className="smithing-station-selected-art">
                        <ItemArtwork
                          itemId={selectedItem.definitionId}
                          category={selectedItem.category}
                          label={selectedItem.displayName}
                        />
                      </div>
                      <div>
                        <span>{formatEquipmentType(selectedItem)}</span>
                        <h3>{selectedItem.displayName}</h3>
                        <small>
                          {selectedItem.location === "equipped"
                            ? "Currently equipped"
                            : "In Inventory"}
                        </small>
                      </div>
                    </header>

                    <div className="smithing-station-level-grid">
                      <StatPanel
                        title="Current"
                        level={selectedItem.itemLevel}
                        stats={selectedItem.derived}
                      />
                      <StatPanel
                        title="After upgrade"
                        level={selectedItem.nextUpgradeLevel}
                        stats={nextStats}
                        previous={selectedItem.derived}
                        emptyLabel={selectedItem.upgradeDisabledReason === "maximum_level"
                          ? "Maximum level reached."
                          : "Upgrade unavailable."}
                      />
                    </div>

                    <section className="smithing-station-cost">
                      <header>
                        <span>Authoritative cost</span>
                        <strong>Personal Gold</strong>
                      </header>
                      {parseInteger(selectedItem.nextUpgradeCost) !== null ? <MaterialChips label="Upgrade cost" materials={[{
                        itemId: "gold",
                        quantity: Number(parseInteger(selectedItem.nextUpgradeCost)),
                        name: "Gold",
                        have: parseInteger(walletGold)
                      }]} /> : <div><strong>{formatInteger(selectedItem.nextUpgradeCost)}</strong></div>}
                    </section>

                    <div className={`smithing-station-requirement${
                      selectedEligibility?.allowed ? " ready" : ""
                    }`}>
                      <strong>
                        <CraftStatusMark ready={Boolean(selectedEligibility?.allowed)} verb="craft" />
                        {" "}{selectedEligibility?.allowed || selectedEligibility?.label === "Insufficient Gold"
                          ? null
                          : selectedEligibility?.reason ?? "Upgrade unavailable"}
                      </strong>
                      <small>
                        Equipment upgrades use only your personal Gold.
                      </small>
                    </div>

                    <GameAppButton
                      variant="primary"
                      className="smithing-station-upgrade"
                      disabled={!selectedEligibility?.allowed || busy}
                      onClick={() => setConfirmationInstanceId(selectedItem.instanceId)}
                    >
                      {busy
                        ? "Upgrade processing..."
                        : feedback?.kind === "error" &&
                            feedback.instanceId === selectedItem.instanceId
                          ? "Retry upgrade"
                          : `Upgrade to level ${selectedItem.itemLevel + 1}`}
                    </GameAppButton>
                  </>
                )}
              </section>
            </div>
          )}
        </div>
      </DestinationShell>
      {confirmationItem && authorityId ? (
        <GameConfirmationPrompt
          title={`Upgrade ${confirmationItem.displayName}?`}
          detail={`Upgrade ${confirmationItem.displayName} from level ${
            confirmationItem.itemLevel
          } to level ${confirmationItem.itemLevel + 1} for ${
            formatInteger(confirmationItem.nextUpgradeCost)
          } personal Gold. The cost is deducted when the authoritative upgrade commits.`}
          confirmLabel="Confirm Upgrade"
          busy={busy}
          onCancel={() => setConfirmationInstanceId(null)}
          onConfirm={confirmUpgrade}
        />
      ) : null}
    </>
  );
}

const EMPTY_INVENTORY: PlayerInventorySnapshot = {
  playerId: "",
  revision: 0,
  items: [],
  totals: emptyInventoryTotals()
};

function EquipmentCraftingView({
  inventory,
  online,
  busy,
  feedback,
  manorSessionId,
  onCraft,
  onCraftRepairKit,
  leatherworkingRank,
  worldKnowledgeRanks,
  hiddenDefinitionIds
}: {
  hiddenDefinitionIds: readonly string[];
  leatherworkingRank: number;
  worldKnowledgeRanks: Readonly<Partial<Record<string, number>>>;
  inventory: PlayerInventorySnapshot;
  online: boolean;
  busy: boolean;
  feedback: SmithingStationUpgradeFeedback | null;
  manorSessionId: string;
  onCraft(recipe: EquipmentCraftRecipe, manorSessionId: string): string | null;
  onCraftRepairKit(manorSessionId: string): string | null;
}): React.JSX.Element {
  const [confirmation, setConfirmation] = useState<EquipmentCraftRecipe | null>(null);
  const [kitConfirmation, setKitConfirmation] = useState(false);
  const spendable = spendableCounts(inventory);
  const kitNeeds = [
    ...REPAIR_KIT_CRAFT_COSTS.map(({ itemId, quantity }) => ({ itemId, quantity, name: humanizeItem(itemId), have: inventory.totals[itemId] ?? 0 })),
    ...categoryNeeds(REPAIR_KIT_CRAFT_CATEGORY_INPUTS, spendable)
  ];
  const kitMissing = kitNeeds.some(({ quantity, have }) => have < quantity);
  const kitSummary = kitNeeds.map(({ quantity, name, itemId }) =>
    `${quantity} ${REPAIR_KIT_CRAFT_COSTS.some((cost) => cost.itemId === itemId) ? name : name.split(" (")[0]}`
  ).join(" and ");
  return <>
    <section className="smithing-acquisition-view" aria-label="Craft stock equipment">
      <header className="smithing-station-section-heading">
        <div><span>Stock recipes</span><strong>Canonical equipment</strong></div>
        <small>Stock recipes craft the canonical item with its stock appearance.</small>
      </header>
      {feedback ? <SmithingFeedback feedback={feedback} /> : null}
      <div className="smithing-acquisition-grid">
        {EQUIPMENT_CRAFT_RECIPES.filter((recipe) => !recipe.requiresSkill ||
          (worldKnowledgeRanks[recipe.requiresSkill.skillId] ?? 0) >= recipe.requiresSkill.rank
        ).map((recipe) => <CraftRecipeCard
          key={recipe.familyId}
          recipe={recipe}
          kicker={humanizeItem(recipe.familyId)}
          inventory={inventory}
          spendable={spendable}
          online={online}
          busy={busy}
          leatherworkingRank={leatherworkingRank}
          onSelect={setConfirmation}
        />)}
        <article className="smithing-acquisition-card">
          <ItemArtwork itemId="repair_kit" category="consumable" label="Repair Kit" />
          <div>
            <span>Repair consumable</span>
            <div className="game-app-card-title-row"><h3>Repair Kit</h3><CraftStatusMark ready={online && !kitMissing} verb="craft" /></div>
            <MaterialChips label="Repair Kit materials" materials={kitNeeds} />
          </div>
          <GameAppButton
            variant="primary"
            className="smithing-station-upgrade"
            disabled={busy || !online || kitMissing}
            title={kitMissing
              ? `Requires ${kitSummary}.`
              : undefined}
            onClick={() => setKitConfirmation(true)}
          >{busy ? "Crafting..." : "Craft"}</GameAppButton>
        </article>
      </div>
      <header className="smithing-station-section-heading">
        <div><span>Swag recipes</span><strong>Swag weapons</strong></div>
        <small>Same stats as the base weapon, crafted at +0. Upgrade and infuse them as usual.</small>
      </header>
      {SWAG_RECIPE_GROUPS.map(({ base, recipes: all }) => ({ base, recipes: all.filter((recipe) => !hiddenDefinitionIds.includes(recipe.definitionId)) })).filter(({ recipes }) => recipes.length > 0).map(({ base, recipes }) => <section
        key={base.familyId}
        className="smithing-swag-group"
        aria-label={`${base.displayName} swag recipes`}
      >
        <h4>{base.displayName}</h4>
        <div className="smithing-acquisition-grid">
          {recipes.map((recipe) => <CraftRecipeCard
            key={recipe.definitionId}
            recipe={recipe}
            kicker={`Swag ${base.displayName}`}
            inventory={inventory}
            spendable={spendable}
            online={online}
            busy={busy}
            leatherworkingRank={leatherworkingRank}
            onSelect={setConfirmation}
          />)}
        </div>
      </section>)}
    </section>
    {confirmation ? <GameConfirmationPrompt
      title={`Craft ${confirmation.displayName}?`}
      category="CRAFT EQUIPMENT"
      detail={`Use ${[
        ...confirmation.materials.map(({ itemId, quantity }) => `${quantity} ${humanizeItem(itemId)}`),
        ...(confirmation.categoryMaterials ?? []).map((input) => `${input.quantity} ${input.category.label}`)
      ].join(" and ")} to create ${"baseDefinitionId" in confirmation
        ? `${confirmation.displayName} at +0, with the same stats as the ${requireEquipmentDefinition(confirmation.baseDefinitionId as EquipmentSwagCraftRecipe["baseDefinitionId"]).displayName}`
        : `the stock ${confirmation.displayName}`}.`}
      confirmLabel="Craft item"
      busy={busy}
      onConfirm={() => {
        if (onCraft(confirmation, manorSessionId)) setConfirmation(null);
      }}
      onCancel={() => setConfirmation(null)}
    /> : null}
    {kitConfirmation ? <GameConfirmationPrompt
      title="Craft Repair Kit?"
      category="REPAIR KIT"
      detail={`Use ${kitSummary} to create one stackable Repair Kit. The lowest grade items are used first.`}
      confirmLabel="Craft Repair Kit"
      busy={busy}
      onConfirm={() => {
        if (onCraftRepairKit(manorSessionId)) setKitConfirmation(false);
      }}
      onCancel={() => setKitConfirmation(false)}
    /> : null}
  </>;
}

const SWAG_RECIPE_GROUPS = EQUIPMENT_CRAFT_RECIPES.flatMap((base) => {
  const recipes = EQUIPMENT_SWAG_CRAFT_RECIPES.filter((recipe) => recipe.familyId === base.familyId);
  return recipes.length > 0 ? [{ base, recipes }] : [];
});

function CraftRecipeCard({
  recipe,
  kicker,
  inventory,
  spendable,
  online,
  busy,
  leatherworkingRank,
  onSelect
}: {
  leatherworkingRank: number;
  recipe: EquipmentCraftRecipe;
  kicker: string;
  inventory: PlayerInventorySnapshot;
  spendable: ReturnType<typeof spendableCounts>;
  online: boolean;
  busy: boolean;
  onSelect(recipe: EquipmentCraftRecipe): void;
}): React.JSX.Element {
  const needs = [
    ...recipe.materials.map(({ itemId, quantity }) => ({ itemId: itemId as string, quantity, name: humanizeItem(itemId), have: inventory.totals[itemId] ?? 0 })),
    ...categoryNeeds(recipe.categoryMaterials ?? [], spendable)
  ];
  const missing = needs.filter(({ quantity, have }) => have < quantity);
  const gateId = equipmentCraftTradeGate(recipe.familyId);
  const gate = gateId ? TRADE_SKILL_GATES[gateId] : null;
  const disabledReason = !online
    ? "Reconnect before crafting equipment."
    : gate && !tradeSkillGateMet(gate, leatherworkingRank)
      ? tradeSkillGateMessage(gate)
      : missing.length > 0
      ? `Missing ${missing.map(({ quantity, have, name }) =>
          `${quantity - have} ${name.split(" (")[0]}`
        ).join(" and ")}.`
      : null;
  return <article className="smithing-acquisition-card">
    <ItemArtwork
      itemId={recipe.definitionId}
      category={requireEquipmentDefinition(recipe.definitionId).category}
      label={recipe.displayName}
    />
    <div>
      <span>{kicker}</span>
      <div className="game-app-card-title-row"><h3>{recipe.displayName}</h3><CraftStatusMark ready={!disabledReason} verb="craft" /></div>
      <MaterialChips label={`${recipe.displayName} materials`} materials={needs} />
    </div>
    <GameAppButton
      variant="primary"
      className="smithing-station-upgrade"
      disabled={busy || Boolean(disabledReason)}
      title={disabledReason ?? undefined}
      onClick={() => onSelect(recipe)}
    >{busy ? "Crafting..." : "Craft"}</GameAppButton>
  </article>;
}

function EquipmentRepairView({
  items,
  inventory,
  online,
  busy,
  feedback,
  manorSessionId,
  selectedItem,
  selectedInstanceId,
  onSelect,
  onRepair,
  blacksmithingRank
}: {
  blacksmithingRank: number;
  items: EquipmentInstanceV2[];
  inventory: PlayerInventorySnapshot;
  online: boolean;
  busy: boolean;
  feedback: SmithingStationUpgradeFeedback | null;
  manorSessionId: string;
  selectedItem: EquipmentInstanceV2 | null;
  selectedInstanceId: string | null;
  onSelect(instanceId: string): void;
  onRepair(item: EquipmentInstanceV2, manorSessionId: string): string | null;
}): React.JSX.Element {
  const repairableItems = items.filter(isRepairable);
  const selected = selectedItem && isRepairable(selectedItem) ? selectedItem : null;
  const selectedCondition = selected?.condition ?? EQUIPMENT_MAX_CONDITION;
  const [confirmation, setConfirmation] = useState<EquipmentInstanceV2 | null>(null);
  const cost = selected ? equipmentRepairCost(selected) : null;
  const materialMissing = cost
    ? [
        { itemId: "repair_kit", quantity: cost.repairKitQuantity },
        ...cost.materials
      ].filter(({ itemId, quantity }) => inventoryQuantity(inventory, itemId) < quantity)
    : [];
  const skilled = tradeSkillGateMet(TRADE_SKILL_GATES.repair_gear, blacksmithingRank);
  const repairAllowed = Boolean(
    selected && cost && online && skilled && selectedCondition < EQUIPMENT_MAX_CONDITION && materialMissing.length === 0
  );
  return <>
    <div className="smithing-station-layout">
      <section className="smithing-station-picker" aria-label="Repairable chest armor">
        <header className="smithing-station-section-heading">
          <div><span>Eligible chest armor</span><strong>{repairableItems.length} armor items</strong></div>
          <small>Death wear applies once per authoritative defeat.</small>
        </header>
        {repairableItems.length === 0 ? <div className="smithing-station-empty">
          <strong>No eligible chest armor</strong>
          <span>Leather Armor, Chainmail Armor, and Breastplate appear here when carried.</span>
        </div> : <div className="game-app-rows smithing-station-equipment-list">
          {repairableItems.map((item) => {
            const condition = item.condition ?? EQUIPMENT_MAX_CONDITION;
            const selectedRow = item.instanceId === selectedInstanceId;
            return <GameAppButton
              key={item.instanceId}
              className={`game-app-row smithing-station-equipment-row${selectedRow ? " selected" : ""}`}
              aria-pressed={selectedRow}
              onClick={() => onSelect(item.instanceId)}
            >
              <ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />
              <span className="smithing-station-item-copy">
                <strong>{item.displayName}</strong>
                <small>{condition === 0 ? "Broken" : condition < 100 ? "Damaged" : "Healthy"} - {condition}/100</small>
              </span>
              <span className={`game-app-badge smithing-station-item-status ${condition === 100 ? "ready" : condition === 0 ? "blocked" : "maximum"}`}>
                {condition}/100
              </span>
            </GameAppButton>;
          })}
        </div>}
      </section>
      <section className="smithing-station-detail" aria-live="polite">
        {feedback ? <SmithingFeedback feedback={feedback} /> : null}
        {!selected ? <div className="smithing-station-empty smithing-station-empty-detail">
          <strong>Select armor</strong><span>Review condition and repair materials here.</span>
        </div> : <>
          <header className="smithing-station-selected-header">
            <div className="smithing-station-selected-art"><ItemArtwork itemId={selected.definitionId} category={selected.category} label={selected.displayName} /></div>
            <div><span>Chest armor</span><h3>{selected.displayName}</h3><small>{selected.location === "equipped" ? "Currently equipped" : "In Inventory"}</small></div>
          </header>
          <section className="smithing-station-cost">
            <header><span>Condition</span><strong>{selectedCondition}/{EQUIPMENT_MAX_CONDITION}</strong></header>
            <div><span>After repair</span><strong>{Math.min(EQUIPMENT_MAX_CONDITION, selectedCondition + 25)}/{EQUIPMENT_MAX_CONDITION}</strong></div>
            <div><span>Materials</span>{cost ? <MaterialChips label="Repair materials" materials={[{ itemId: "repair_kit", quantity: cost.repairKitQuantity }, ...cost.materials].map(({ itemId, quantity }) => ({
              itemId, quantity, name: humanizeItem(itemId), have: inventoryQuantity(inventory, itemId)
            }))} /> : <strong>Unavailable</strong>}</div>
          </section>
          <div className={`smithing-station-requirement${repairAllowed ? " ready" : ""}`}>
            <strong><CraftStatusMark ready={repairAllowed} verb="craft" /> {selectedCondition >= EQUIPMENT_MAX_CONDITION ? "Already fully repaired" : !online ? "Reconnect before repairing" : !skilled ? tradeSkillGateMessage(TRADE_SKILL_GATES.repair_gear) : materialMissing.length || repairAllowed ? null : "Repair unavailable"}</strong>
            <small>Repair consumes one Repair Kit and the listed material. Gold is never charged.</small>
          </div>
          <GameAppButton variant="primary" className="smithing-station-upgrade" disabled={!repairAllowed || busy} onClick={() => setConfirmation(selected)}>
            {busy ? "Repair processing..." : "Repair +25 condition"}
          </GameAppButton>
        </>}
      </section>
    </div>
    {confirmation ? <GameConfirmationPrompt
      title={`Repair ${confirmation.displayName}?`}
      category="REPAIR ARMOR"
      detail={`Restore up to 25 condition using one Repair Kit and the listed family material. No Gold is charged.`}
      confirmLabel="Confirm Repair"
      busy={busy}
      onConfirm={() => {
        if (onRepair(confirmation, manorSessionId)) setConfirmation(null);
      }}
      onCancel={() => setConfirmation(null)}
    /> : null}
  </>;
}

function LimitedEquipmentView({
  walletGold,
  online,
  busy,
  feedback,
  manorSessionId,
  onPurchase
}: {
  walletGold: string | null;
  online: boolean;
  busy: boolean;
  feedback: SmithingStationUpgradeFeedback | null;
  manorSessionId: string;
  onPurchase(sale: ActiveEquipmentLimitedSale, manorSessionId: string): string | null;
}): React.JSX.Element {
  const sales = activeEquipmentLimitedSales();
  const [confirmation, setConfirmation] = useState<ActiveEquipmentLimitedSale | null>(null);
  const balance = parseInteger(walletGold);
  return <>
    <section className="smithing-acquisition-view" aria-label="Limited equipment">
      <header className="smithing-station-section-heading">
        <div><span>Limited appearances</span><strong>Same family power</strong></div>
        <small>These items change appearance only and cannot be crafted after their sale.</small>
      </header>
      {feedback ? <SmithingFeedback feedback={feedback} /> : null}
      {sales.length === 0 ? <div className="smithing-station-empty">
        <strong>No limited equipment is for sale</strong>
        <span>New cosmetic equipment will appear here during its sale window.</span>
      </div> : <div className="smithing-acquisition-grid">
        {sales.map((sale) => {
          const definition = requireEquipmentDefinition(sale.definitionId);
          const price = BigInt(sale.priceGold);
          const disabledReason = !online
            ? "Reconnect before purchasing equipment."
            : balance === null
              ? "Waiting for your authoritative Gold balance."
              : balance < price
                ? `You need ${(price - balance).toLocaleString()} more Gold.`
                : null;
          return <article key={sale.definitionId} className="smithing-acquisition-card">
            <ItemArtwork
              itemId={sale.definitionId}
              category={definition.category}
              label={sale.displayName}
            />
            <div>
              <span>{humanizeItem(sale.familyId)} appearance</span>
              <h3>{sale.displayName}</h3>
              <p>{formatInteger(sale.priceGold)} Gold / Ends {
                new Date(sale.endsAt).toLocaleDateString()
              }</p>
            </div>
            <GameAppButton
              variant="primary"
              className="smithing-station-upgrade"
              disabled={busy || Boolean(disabledReason)}
              title={disabledReason ?? undefined}
              onClick={() => setConfirmation(sale)}
            >{busy ? "Purchasing..." : "Buy"}</GameAppButton>
          </article>;
        })}
      </div>}
    </section>
    {confirmation ? <GameConfirmationPrompt
      title={`Buy ${confirmation.displayName}?`}
      category="LIMITED EQUIPMENT"
      detail={`Spend ${formatInteger(confirmation.priceGold)} Gold. This item has the same raw stats as the stock ${
        requireEquipmentDefinition(confirmation.definitionId).gameplayFamilyId.replaceAll("_", " ")
      } family and remains yours after the sale ends.`}
      confirmLabel={`Buy for ${formatInteger(confirmation.priceGold)} Gold`}
      busy={busy}
      onConfirm={() => {
        if (onPurchase(confirmation, manorSessionId)) setConfirmation(null);
      }}
      onCancel={() => setConfirmation(null)}
    /> : null}
  </>;
}

function SmithingFeedback({ feedback }: {
  feedback: SmithingStationUpgradeFeedback;
}): React.JSX.Element {
  const error = feedback.kind === "error";
  const message = feedback.kind === "success"
    ? `${feedback.displayName} upgraded to level ${feedback.levelAfter}.`
    : feedback.message;
  return <div className={`smithing-station-feedback ${error ? "error" : "success"}`} role="status">
    <strong>{message}</strong>
    {error ? <small>{feedback.code}</small> : null}
  </div>;
}

function humanizeItem(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function FacilityState({
  title,
  message,
  retry
}: {
  title: string;
  message: string;
  retry: (() => void) | null;
}): React.JSX.Element {
  return (
    <div className="destination-empty-state smithing-station-empty-state">
      <strong>{title}</strong>
      <span>{message}</span>
      {retry ? <GameAppButton onClick={retry}>Retry</GameAppButton> : null}
    </div>
  );
}

function StatPanel({
  title,
  level,
  stats,
  previous,
  emptyLabel = "Upgrade unavailable."
}: {
  title: string;
  level: number | null;
  stats: EquipmentItemDerivedStats | null;
  previous?: EquipmentItemDerivedStats;
  emptyLabel?: string;
}): React.JSX.Element {
  return (
    <section className="smithing-station-stat-panel">
      <span>{title}</span>
      <strong>Level {level ?? "-"}</strong>
      {stats ? (
        <dl className="game-app-stats">
          {stats.pveAttackContribution > 0 ? (
            <StatRow
              label="Attack"
              value={stats.pveAttackContribution}
              previous={previous?.pveAttackContribution}
            />
          ) : null}
          {stats.pveDefenseContribution > 0 ? (
            <StatRow
              label="Defense"
              value={stats.pveDefenseContribution}
              previous={previous?.pveDefenseContribution}
            />
          ) : null}
          <StatRow
            label="PvP level"
            value={stats.pvpLevelContribution}
            previous={previous?.pvpLevelContribution}
          />
        </dl>
      ) : <small>{emptyLabel}</small>}
    </section>
  );
}

function StatRow({
  label,
  value,
  previous
}: {
  label: string;
  value: number;
  previous?: number | undefined;
}): React.JSX.Element {
  const delta = previous === undefined ? null : value - previous;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {formatStat(value)}
        {delta !== null && delta > 0 ? <em>+{formatStat(delta)}</em> : null}
      </dd>
    </>
  );
}

function resolveNextStats(
  item: EquipmentInstanceV2,
  equipment: EquipmentSnapshotV2
): EquipmentItemDerivedStats {
  return resolveEquipmentItemDerivedStats({
    item: {
      instanceId: item.instanceId,
      definition: requireEquipmentDefinition(item.definitionId),
      itemLevel: item.itemLevel + 1,
      ...(item.condition === undefined ? {} : { condition: item.condition })
    },
    slot: item.derived.slot,
    classId: equipment.derivedStats.classId
  });
}

function isRepairable(item: EquipmentInstanceV2): boolean {
  const definition = requireEquipmentDefinition(item.definitionId);
  return definition.category === "chest_armor" &&
    equipmentRepairCostForFamily(definition.gameplayFamilyId) !== null;
}

function equipmentRepairCost(item: EquipmentInstanceV2): EquipmentRepairCost | null {
  return equipmentRepairCostForFamily(
    requireEquipmentDefinition(item.definitionId).gameplayFamilyId
  );
}

function inventoryQuantity(inventory: PlayerInventorySnapshot, itemId: string): number {
  return (inventory.totals as Record<string, number | undefined>)[itemId] ?? 0;
}

function upgradeEligibility({
  item,
  walletGold,
  online
}: {
  item: EquipmentInstanceV2;
  walletGold: string | null;
  online: boolean;
}): {
  allowed: boolean;
  label: string;
  reason: string | null;
  tone: "ready" | "blocked" | "maximum";
} {
  if (item.upgradeDisabledReason === "maximum_level") {
    return blocked("Maximum level", "This item is already at the global maximum level.", "maximum");
  }
  if (item.upgradeDisabledReason === "character_level_required") {
    const requiredLevel = item.nextUpgradeLevel ?? item.itemLevel + 1;
    return blocked(
      `Requires Level ${requiredLevel}`,
      `Requires character level ${requiredLevel}.`
    );
  }
  if (item.upgradeDisabledReason === "destroyed" || item.upgradeDisabledReason === "not_owned") {
    return blocked("Unavailable", "This equipment is no longer eligible for upgrade.");
  }
  if (item.nextUpgradeLevel === null) {
    return blocked("Unavailable", "The authoritative upgrade eligibility is unavailable.");
  }
  if (!online) return blocked("Offline", "Reconnect before upgrading equipment.");
  return walletEligibility(item, walletGold);
}

function walletEligibility(
  item: EquipmentInstanceV2,
  walletGold: string | null
): {
  allowed: boolean;
  label: string;
  reason: string | null;
  tone: "ready" | "blocked" | "maximum";
} {
  if (walletGold === null) {
    return blocked("Checking cost", "Waiting for your authoritative Gold balance.");
  }
  const cost = parseInteger(item.nextUpgradeCost);
  const balance = parseInteger(walletGold);
  if (cost === null || balance === null) {
    return blocked("Cost unavailable", "The authoritative upgrade cost is unavailable.");
  }
  if (balance < cost) {
    return blocked(
      "Insufficient Gold",
      `You need ${formatInteger(String(cost - balance))} more personal Gold.`
    );
  }
  return {
    allowed: true,
    label: "Upgradeable",
    reason: null,
    tone: "ready"
  };
}

function blocked(
  label: string,
  reason: string,
  tone: "blocked" | "maximum" = "blocked"
) {
  return { allowed: false, label, reason, tone } as const;
}

function formatEquipmentType(item: EquipmentInstanceV2): string {
  if (item.weaponCategory) return `${capitalize(item.weaponCategory)} weapon`;
  if (item.category === "shield") return "Shield";
  if (item.category.startsWith("gathering_")) return "Gathering tool";
  const slot = item.derived.slot;
  return `${capitalize(slot)}${slot === "ring" ? "" : " armor"}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function parseInteger(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function formatInteger(value: string | null): string {
  const parsed = parseInteger(value);
  return parsed === null ? "Unavailable" : parsed.toLocaleString();
}

function formatStat(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}
