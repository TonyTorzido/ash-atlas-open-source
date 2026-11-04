import { useState } from "react";

import { LOADOUT_SCROLL_DESCRIPTION, LOADOUT_SCROLL_DISPLAY_NAME, LOADOUT_SCROLL_ITEM_ID, LOADOUT_SCROLL_MATERIALS } from "@ash-atlas/shared";
import {
  BACKPACK_LEVELS,
  EQUIPMENT_CRAFT_RECIPES,
  EQUIPMENT_SWAG_CRAFT_RECIPES,
  GATHERING_TOOL_FAMILIES,
  isPortableEquipmentCraft,
  type EquipmentGameplayFamilyId,
  FLAG_BURN_OUTPUT,
  FIELD_CONSUMABLE_DESCRIPTIONS,
  FIELD_CONSUMABLE_ITEM_IDS,
  FIELD_CONSUMABLE_NAMES,
  FIELD_CONSUMABLE_RECIPES,
  FIELD_CONSUMABLE_SKILL_REQUIREMENTS,
  FIELD_CRAFT_TRADE_GATES,
  TRADE_SKILL_GATES,
  UTILITY_GEAR,
  UTILITY_GEAR_DEFINITION_IDS,
  type UtilityGearDefinitionId,
  tradeSkillGateMessage,
  tradeSkillGateMet,
  FLAG_BURN_RECIPE,
  INVENTORY_CATALOG,
  type FieldConsumableItemId,
  GREENHOUSE_FERTILIZER_CATEGORY_INPUTS,
  GREENHOUSE_FERTILIZER_RECIPE,
  type InventoryItemType,
  type MarketInteger,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";

import { categoryNeeds } from "./MaterialCategoryUi.js";
import { GameAppActionBar, GameAppButton, GameAppCard, GameAppSectionHeader, GameAppShell, GameAppState, GameAppText } from "./GameAppShell.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChips } from "./MaterialRequirements.js";

const RESOURCE_LABELS: Readonly<Partial<Record<ResourceType, string>>> = {
  coal: "Coal",
  crude_oil: "Crude Oil",
  simple_food: "Simple Food"
};

/** Swag weapons are crafted only at a Manor Smithing Station; Crafting lists them read-only by base weapon. */
const GATHERING_TOOL_RECIPES = EQUIPMENT_CRAFT_RECIPES.filter(
  (recipe) => GATHERING_TOOL_FAMILIES[recipe.familyId] !== undefined
);

const SWAG_RECIPE_GROUPS = EQUIPMENT_CRAFT_RECIPES.flatMap((base) => {
  const recipes = EQUIPMENT_SWAG_CRAFT_RECIPES.filter((recipe) => recipe.familyId === base.familyId);
  return recipes.length > 0 ? [{ base, recipes }] : [];
});

export type CraftingPanelProps = Readonly<{
  open: boolean;
  inventory: PlayerInventorySnapshot;
  hasSnapshot: boolean;
  connectionStatus: "offline" | "connecting" | "online";
  layout: "desktop" | "phone";
  busy?: boolean;
  error?: string | null;
  goldBalance?: MarketInteger | null;
  onCraftTorches(): boolean;
  onCraftFertilizer?(): boolean;
  onCraftBackpack?(): boolean;
  onCraftFieldConsumable?(itemId: FieldConsumableItemId): boolean;
  /** Utility gear is crafted by active Atlas Pass members only; the server enforces it too. */
  atlasPassActive?: boolean;
  onCraftUtilityGear?(definitionId: UtilityGearDefinitionId): boolean;
  onCraftGearScroll?(): boolean;
  /** Starter gathering tools (portableCraft families) are crafted on the player, anywhere. */
  onCraftGatheringTool?(familyId: EquipmentGameplayFamilyId): boolean;
  /** Tidecraft rank for the Tidecraft recipes (0 when not learned). */
  tidecraftRank?: number;
  /** Swag weapons sold shop-only: their recipe is not listed. */
  hiddenDefinitionIds?: readonly string[];
  /** Blacksmithing rank; Field Traps need rank 3 to craft. */
  blacksmithingRank?: number;
  alchemyRank?: number;
  leatherworkingRank?: number;
  onClose(): void;
}>;

/** Check mark (success tone) when craftable, X (error tone) when not; any in-progress/error text stays beside it. */
function CraftStatus({ ready, text, ok }: { ready: boolean; text: string | null; ok: string }): React.JSX.Element {
  const shown = text && text !== ok && text !== "Missing materials" ? text : null;
  return <><CraftStatusMark ready={ready} verb="craft" />{shown}</>;
}

function rowLabel(label: string, owned: number | bigint, required: number): string {
  const missing = BigInt(required) - BigInt(owned);
  return `${label} ${required.toLocaleString()}, have ${owned.toLocaleString()}${missing > 0n ? `, missing ${missing.toLocaleString()}` : ""}`;
}

/** Case-insensitive match of the search text against a recipe's name and its material names. */
function recipeMatches(query: string, ...texts: readonly string[]): boolean {
  return query === "" || texts.some((text) => text.toLowerCase().includes(query));
}

function materialNames(materials: ReadonlyArray<{ itemId: InventoryItemType }>): string[] {
  return materials.map(({ itemId }) => INVENTORY_CATALOG[itemId]?.displayName ?? itemId);
}

export function CraftingPanel(props: CraftingPanelProps): React.JSX.Element | null {
  const [search, setSearch] = useState("");
  if (!props.open) return null;
  const query = search.trim().toLowerCase();

  const quantities = new Map<InventoryItemType, number>();
  for (const item of props.inventory.items) {
    // The server projects its persisted default variant as protocol `null`.
    // Keep accepting the literal for older fixtures/clients, and aggregate
    // split stacks instead of letting a later stack hide earlier quantity.
    if (item.variant !== null && item.variant !== "default") continue;
    quantities.set(
      item.resourceType,
      (quantities.get(item.resourceType) ?? 0) + item.quantity
    );
  }
  const requirements = FLAG_BURN_RECIPE.map((requirement) => ({
    ...requirement,
    label: RESOURCE_LABELS[requirement.itemId] ?? requirement.itemId,
    owned: quantities.get(requirement.itemId) ?? 0
  }));
  const hasMaterials = requirements.every((requirement) => requirement.owned >= requirement.quantity);
  const canCraft = !props.busy && props.connectionStatus === "online" && props.hasSnapshot &&
    hasMaterials;
  const status = props.error
    ? "Craft failed"
    : props.busy
      ? "Crafting"
      : !props.hasSnapshot
    ? "Waiting for inventory"
    : props.connectionStatus !== "online"
      ? "Reconnect to craft"
      : canCraft ? "Ready to craft" : "Missing materials";
  const guidance = props.error
    ?? (props.hasSnapshot && props.connectionStatus !== "online" ? "Reconnect before crafting." : null);
  const backpackRecipe = BACKPACK_LEVELS[0]!;
  const fertilizerRequirements = [
    ...GREENHOUSE_FERTILIZER_RECIPE.map((requirement) => ({
      ...requirement,
      label: RESOURCE_LABELS[requirement.itemId] ?? (requirement.itemId === "flux_plant" ? "Flux Plant" : requirement.itemId),
      owned: quantities.get(requirement.itemId) ?? 0
    })),
    ...categoryNeeds(GREENHOUSE_FERTILIZER_CATEGORY_INPUTS, quantities).map((need) => ({
      itemId: need.itemId, quantity: need.quantity, label: need.name, owned: need.have
    }))
  ];
  const fertilizerReady = fertilizerRequirements.every((requirement) => requirement.owned >= requirement.quantity);
  const canCraftFertilizer = !props.busy && props.connectionStatus === "online" && props.hasSnapshot &&
    Boolean(props.onCraftFertilizer) && fertilizerReady;
  const gold = props.goldBalance === null || props.goldBalance === undefined
    ? null
    : BigInt(props.goldBalance);
  const backpackLeather = quantities.get("leather") ?? 0;
  const backpackReady = backpackLeather >= backpackRecipe.upgradeCost.leather &&
    gold !== null && gold >= BigInt(backpackRecipe.upgradeCost.gold);
  const backpackGate = TRADE_SKILL_GATES.craft_backpack;
  const backpackSkilled = tradeSkillGateMet(backpackGate, props.leatherworkingRank ?? 0);
  const canCraftBackpack = !props.busy && props.connectionStatus === "online" && props.hasSnapshot &&
    Boolean(props.onCraftBackpack) && backpackReady && backpackSkilled;
  const backpackGuidance = props.hasSnapshot && props.connectionStatus !== "online"
    ? "Reconnect before crafting."
    : props.hasSnapshot && (props.goldBalance === null || props.goldBalance === undefined)
      ? "Gold balance is unavailable."
      : null;

  const showTorches = recipeMatches(query, "Torches", ...requirements.map((requirement) => requirement.label));
  const showFertilizer = recipeMatches(query, "Fertilizer", ...fertilizerRequirements.map((requirement) => requirement.label));
  const showBackpack = recipeMatches(query, "Backpack", "Leather", "Gold");
  const consumableIds = FIELD_CONSUMABLE_ITEM_IDS.filter((itemId) =>
    recipeMatches(query, FIELD_CONSUMABLE_NAMES[itemId], ...materialNames(FIELD_CONSUMABLE_RECIPES[itemId].inputs)));
  const gatheringRecipes = GATHERING_TOOL_RECIPES.filter((recipe) =>
    recipeMatches(query, recipe.displayName, ...materialNames(recipe.materials)));
  const utilityIds = UTILITY_GEAR_DEFINITION_IDS.filter((definitionId) =>
    recipeMatches(query, UTILITY_GEAR[definitionId].displayName, ...materialNames(UTILITY_GEAR[definitionId].materials)));
  const showScroll = recipeMatches(query, LOADOUT_SCROLL_DISPLAY_NAME, ...materialNames(LOADOUT_SCROLL_MATERIALS));
  const swagGroups = SWAG_RECIPE_GROUPS.flatMap(({ base, recipes }) => {
    const shown = recipes.filter((recipe) => !props.hiddenDefinitionIds?.includes(recipe.definitionId) &&
      recipeMatches(query, recipe.displayName, base.displayName, ...materialNames(recipe.materials)));
    return shown.length > 0 ? [{ base, recipes: shown }] : [];
  });
  const showSupplies = showTorches || showFertilizer;
  const showConsumables = consumableIds.length > 0;
  const showGathering = gatheringRecipes.length > 0;
  const showUtility = utilityIds.length > 0 || showScroll;
  const showSwag = swagGroups.length > 0;
  const nothingMatches = !showSupplies && !showConsumables && !showBackpack && !showGathering && !showUtility && !showSwag;

  return <GameAppShell
    open
    title="Crafting"
    menuId="crafting"
    headerStatus={props.hasSnapshot ? { value: `${(hasMaterials ? 1 : 0) + (backpackReady ? 1 : 0)} / 2`, label: "Ready" } : null}
    closeLabel="Close Crafting"
    className="crafting-app"
    layout={props.layout}
    phoneBackLabel="Back to Game Menu"
    closeDisabled={props.busy ?? false}
    onClose={props.onClose}
  >
    <div className="crafting-app-body">
      <div className="inventory-search" role="search">
        <input type="text" inputMode="search" enterKeyHint="search" autoComplete="off" spellCheck={false} className="inventory-search-input"
          aria-label="Search recipes" placeholder="Search recipes" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        {search ? <GameAppButton type="button" variant="quiet" className="game-app-button-compact" onClick={() => setSearch("")}>Clear</GameAppButton> : null}
      </div>
      {nothingMatches ? <GameAppState className="empty-state">No recipes match.</GameAppState> : null}
      {showSupplies ? <section className="crafting-swag" aria-label="Supplies">
        <GameAppSectionHeader title="Supplies" description="Torches and fertilizer." />
        <div className="game-app-card-grid">
        {showTorches ? <GameAppCard
          title="Torches"
          className={`phone-build-card${props.busy ? " active" : ""}${hasMaterials || !props.hasSnapshot ? "" : " missing-materials"}`}
          badge={`+${FLAG_BURN_OUTPUT.quantity}`}
          status={<CraftStatus ready={canCraft} text={status} ok="Ready to craft" />}
          description="Make supplies for burning another player's personal Flag."
          action={<GameAppActionBar>
            <GameAppButton
              type="button"
              variant="primary"
              disabled={!canCraft}
              title={canCraft ? "10 Coal + 100 Crude Oil" : guidance ?? undefined}
              onClick={() => props.onCraftTorches()}
            >{props.busy ? "Crafting…" : `Craft ${FLAG_BURN_OUTPUT.quantity} Torches`}</GameAppButton>
          </GameAppActionBar>}
        >
          <div className="game-app-rows crafting-recipe-materials" aria-label="Torch requirements">
            {requirements.map((requirement) => <span
              key={requirement.itemId}
              className="game-app-row"
              data-state={requirement.owned >= requirement.quantity ? "met" : "short"}
              aria-label={rowLabel(requirement.label, requirement.owned, requirement.quantity)}
            >
              <ItemArtwork
                itemId={requirement.itemId}
                variant="default"
                label={requirement.label}
              />
              <strong>{requirement.quantity.toLocaleString()} {requirement.label}</strong>
              <b className="game-app-row-value">{requirement.owned.toLocaleString()} owned</b>
            </span>)}
          </div>
          {guidance ? <GameAppText tone={props.error ? "error" : "helper"} className={props.error ? "crafting-recipe-error" : undefined} {...(props.error ? { role: "alert" } : {})}>{guidance}</GameAppText> : null}
        </GameAppCard> : null}
        {showFertilizer ? <GameAppCard
          title="Fertilizer"
          className={`phone-build-card${props.busy ? " active" : ""}${fertilizerReady || !props.hasSnapshot ? "" : " missing-materials"}`}
          badge="+1"
          status={<CraftStatus ready={canCraftFertilizer} text={props.busy ? "Crafting" : null} ok="" />}
          description="Prepare one Fertilizer for a Farm Plot."
          action={<GameAppActionBar>
            <GameAppButton
              type="button"
              variant="primary"
              disabled={!canCraftFertilizer}
              title={canCraftFertilizer ? "5 Simple Food + 1 Bone + 1 Flux Plant" : "Requires 5 Simple Food, 1 Bone, and 1 Flux Plant."}
              onClick={() => props.onCraftFertilizer?.()}
            >{props.busy ? "Crafting…" : "Craft Fertilizer"}</GameAppButton>
          </GameAppActionBar>}
        >
          <div className="game-app-rows crafting-recipe-materials" aria-label="Fertilizer requirements">
            {fertilizerRequirements.map((requirement) => <span
              key={requirement.itemId}
              className="game-app-row"
              data-state={requirement.owned >= requirement.quantity ? "met" : "short"}
              aria-label={rowLabel(requirement.label, requirement.owned, requirement.quantity)}
            >
              <ItemArtwork itemId={requirement.itemId} variant="default" label={requirement.label} />
              <strong>{requirement.quantity.toLocaleString()} {requirement.label}</strong>
              <b className="game-app-row-value">{requirement.owned.toLocaleString()} owned</b>
            </span>)}
          </div>
        </GameAppCard> : null}
        </div>
      </section> : null}
      {showBackpack ? <section className="crafting-swag" aria-label="Bags">
        <GameAppSectionHeader title="Bags" description="Backpacks carry more. Equip one from Inventory." />
        <div className="game-app-card-grid">
        <GameAppCard
          title="Backpack +0"
          className={`phone-build-card${props.busy ? " active" : ""}${backpackReady || !props.hasSnapshot ? "" : " missing-materials"}`}
          badge="+0"
          status={<CraftStatus ready={canCraftBackpack} text={props.busy ? "Crafting" : null} ok="" />}
          description="Craft one persistent backpack instance. Equip it later from Inventory to add its capacity."
          leading={<ItemArtwork itemId="pack" label="Backpack +0" />}
          action={<GameAppActionBar>
            <GameAppButton
              type="button"
              variant="primary"
              disabled={!canCraftBackpack}
              title={canCraftBackpack ? "80 Leather + 2,000 Gold" : backpackGuidance ?? undefined}
              onClick={() => props.onCraftBackpack?.()}
            >{props.busy ? "Crafting…" : "Craft Backpack +0"}</GameAppButton>
          </GameAppActionBar>}
        >
          <div className="game-app-rows crafting-recipe-materials" aria-label="Backpack requirements">
            <span className="game-app-row" data-state={backpackLeather >= backpackRecipe.upgradeCost.leather ? "met" : "short"} aria-label={rowLabel("Leather", backpackLeather, backpackRecipe.upgradeCost.leather)}>
              <ItemArtwork itemId="leather" variant="default" label="Leather" />
              <strong>{backpackRecipe.upgradeCost.leather.toLocaleString()} Leather</strong>
              <b className="game-app-row-value">{backpackLeather.toLocaleString()} owned</b>
            </span>
            <span className="game-app-row" data-state={(gold ?? 0n) >= BigInt(backpackRecipe.upgradeCost.gold) ? "met" : "short"} aria-label={rowLabel("Gold", gold ?? 0n, backpackRecipe.upgradeCost.gold)}>
              <span className="crafting-currency-icon game-app-row-art" aria-hidden="true">✦</span>
              <strong>{backpackRecipe.upgradeCost.gold.toLocaleString()} Gold</strong>
              <b className="game-app-row-value">{(gold ?? 0n).toLocaleString()} owned</b>
            </span>
          </div>
          {!backpackSkilled ? <GameAppText tone="helper">{tradeSkillGateMessage(backpackGate)}</GameAppText> : null}
          {backpackGuidance ? <GameAppText tone="helper">{backpackGuidance}</GameAppText> : null}
        </GameAppCard>
        </div>
      </section> : null}
      {showConsumables ? <section className="crafting-swag" aria-label="Field consumables">
        <GameAppSectionHeader title="Field Consumables" description="Tonics, traps and wards for the field." />
        <div className="game-app-card-grid">
        {consumableIds.map((itemId) => {
          const recipe = FIELD_CONSUMABLE_RECIPES[itemId];
          const name = FIELD_CONSUMABLE_NAMES[itemId];
          const rows = recipe.inputs.map((input) => ({
            ...input,
            label: INVENTORY_CATALOG[input.itemId]?.displayName ?? input.itemId,
            owned: quantities.get(input.itemId) ?? 0
          }));
          const ready = rows.every((row) => row.owned >= row.quantity);
          const requirement = FIELD_CONSUMABLE_SKILL_REQUIREMENTS[itemId];
          const rankShort = requirement !== undefined && (props.tidecraftRank ?? 0) < requirement.rank;
          const gateId = FIELD_CRAFT_TRADE_GATES[itemId];
          const tradeGate = gateId ? TRADE_SKILL_GATES[gateId] : null;
          const tradeRank = tradeGate?.skillId === "blacksmithing" ? props.blacksmithingRank
            : tradeGate?.skillId === "alchemy" ? props.alchemyRank
            : tradeGate?.skillId === "leatherworking" ? props.leatherworkingRank
            : 0;
          const tradeShort = tradeGate !== null && !tradeSkillGateMet(tradeGate, tradeRank ?? 0);
          const canCraftItem = !props.busy && props.connectionStatus === "online" && props.hasSnapshot &&
            Boolean(props.onCraftFieldConsumable) && ready && !rankShort && !tradeShort;
          return <GameAppCard
            key={itemId}
            title={name}
            className={`phone-build-card${props.busy ? " active" : ""}${ready || !props.hasSnapshot ? "" : " missing-materials"}`}
            badge={`+${recipe.output}`}
            status={<CraftStatusMark ready={canCraftItem} verb="craft" />}
            description={FIELD_CONSUMABLE_DESCRIPTIONS[itemId]}
            action={<GameAppActionBar>
              <GameAppButton
                type="button"
                variant="primary"
                disabled={!canCraftItem}
                                onClick={() => props.onCraftFieldConsumable?.(itemId)}
              >{props.busy ? "Crafting…" : `Craft ${recipe.output === 1 ? name : `${recipe.output} ${name}s`}`}</GameAppButton>
            </GameAppActionBar>}
          >
            <div className="game-app-rows crafting-recipe-materials" aria-label={`${name} requirements`}>
              {rows.map((row) => <span
                key={row.itemId}
                className="game-app-row"
                data-state={row.owned >= row.quantity ? "met" : "short"}
                aria-label={rowLabel(row.label, row.owned, row.quantity)}
              >
                <ItemArtwork itemId={row.itemId} variant="default" label={row.label} />
                <strong>{row.quantity.toLocaleString()} {row.label}</strong>
                <b className="game-app-row-value">{row.owned.toLocaleString()} owned</b>
              </span>)}
            </div>
            {rankShort ? <GameAppText tone="helper">Needs Tidecraft rank {requirement!.rank}.</GameAppText> : null}
            {tradeShort ? <GameAppText tone="helper">{tradeSkillGateMessage(tradeGate!)}</GameAppText> : null}
          </GameAppCard>;
        })}
        </div>
      </section> : null}
      {showGathering ? <section className="crafting-swag" aria-label="Gathering tools">
        <GameAppSectionHeader
          title="Gathering Tools"
          description="Shown in your hand while chopping, mining or fishing. Looks only. Starter tools craft anywhere; equip them from Inventory."
        />
        <div className="game-app-card-grid">
          {gatheringRecipes.map((recipe) => {
            const needs = recipe.materials.map(({ itemId, quantity }) => ({
              itemId,
              quantity,
              name: INVENTORY_CATALOG[itemId]?.displayName ?? itemId,
              have: props.hasSnapshot ? quantities.get(itemId) ?? 0 : null
            }));
            const ready = props.hasSnapshot && needs.every(({ quantity, have }) => (have ?? 0) >= quantity);
            const portable = isPortableEquipmentCraft(recipe.familyId);
            const canCraftTool = portable && !props.busy && props.connectionStatus === "online" && ready &&
              Boolean(props.onCraftGatheringTool);
            return <GameAppCard
              key={recipe.definitionId}
              title={recipe.displayName}
              className={`phone-build-card${props.busy ? " active" : ""}${ready || !props.hasSnapshot ? "" : " missing-materials"}`}
              leading={<ItemArtwork itemId={recipe.definitionId} label={recipe.displayName} />}
              status={<CraftStatusMark ready={ready} verb="craft" />}
              description={portable ? "Tool slot" : "Tool slot. Craft at your Manor's Smithing Station."}
              {...(portable ? { action: <GameAppActionBar>
                <GameAppButton
                  type="button"
                  variant="primary"
                  disabled={!canCraftTool}
                  onClick={() => props.onCraftGatheringTool?.(recipe.familyId)}
                >{props.busy ? "Crafting…" : `Craft ${recipe.displayName}`}</GameAppButton>
              </GameAppActionBar> } : {})}
            >
              <MaterialChips label={`${recipe.displayName} materials`} materials={needs} />
            </GameAppCard>;
          })}
        </div>
      </section> : null}
      {showUtility ? <section className="crafting-swag" aria-label="Utility gear">
        <GameAppSectionHeader
          title="Utility Gear"
          description="Gloves and boots with a limited number of uses. Lumen items are crafted by Atlas Pass members; all are usable by anyone."
        />
        <div className="game-app-card-grid">
          {utilityIds.map((definitionId) => {
            const spec = UTILITY_GEAR[definitionId];
            const needs = spec.materials.map(({ itemId, quantity }) => ({
              itemId,
              quantity,
              name: INVENTORY_CATALOG[itemId]?.displayName ?? itemId,
              have: props.hasSnapshot ? quantities.get(itemId) ?? 0 : null
            }));
            const ready = props.hasSnapshot && needs.every(({ quantity, have }) => (have ?? 0) >= quantity);
            const canCraftGear = !props.busy && props.connectionStatus === "online" && ready &&
              props.atlasPassActive === true && Boolean(props.onCraftUtilityGear);
            return <GameAppCard
              key={definitionId}
              title={spec.displayName}
              className="phone-build-card"
              badge={`${spec.uses} uses`}
              leading={<ItemArtwork itemId={definitionId} label={spec.displayName} />}
              status={<CraftStatusMark ready={ready} verb="craft" />}
              description={spec.description}
              {...(canCraftGear ? { action: <GameAppActionBar>
                <GameAppButton
                  type="button"
                  variant="primary"
                  onClick={() => props.onCraftUtilityGear?.(definitionId)}
                >{`Craft ${spec.displayName}`}</GameAppButton>
              </GameAppActionBar> } : {})}
            >
              <MaterialChips label={`${spec.displayName} materials`} materials={needs} />
            </GameAppCard>;
          })}
          {showScroll ? (() => {
            const needs = LOADOUT_SCROLL_MATERIALS.map(({ itemId, quantity }) => ({
              itemId,
              quantity,
              name: INVENTORY_CATALOG[itemId]?.displayName ?? itemId,
              have: props.hasSnapshot ? quantities.get(itemId) ?? 0 : null
            }));
            const ready = props.hasSnapshot && needs.every(({ quantity, have }) => (have ?? 0) >= quantity);
            const canCraft = !props.busy && props.connectionStatus === "online" && ready &&
              props.atlasPassActive === true && Boolean(props.onCraftGearScroll);
            return <GameAppCard
              key={LOADOUT_SCROLL_ITEM_ID}
              title={LOADOUT_SCROLL_DISPLAY_NAME}
              className="phone-build-card"
              leading={<ItemArtwork itemId={LOADOUT_SCROLL_ITEM_ID} label={LOADOUT_SCROLL_DISPLAY_NAME} />}
              status={<CraftStatusMark ready={ready} verb="craft" />}
              description={LOADOUT_SCROLL_DESCRIPTION}
              {...(canCraft ? { action: <GameAppActionBar>
                <GameAppButton type="button" variant="primary" onClick={() => props.onCraftGearScroll?.()}>
                  {`Craft ${LOADOUT_SCROLL_DISPLAY_NAME}`}
                </GameAppButton>
              </GameAppActionBar> } : {})}
            >
              <MaterialChips label={`${LOADOUT_SCROLL_DISPLAY_NAME} materials`} materials={needs} />
            </GameAppCard>;
          })() : null}
        </div>
      </section> : null}
      {showSwag ? <section className="crafting-swag" aria-label="Swag weapons">
        <GameAppSectionHeader
          title="Swag Weapons"
          description="Same stats as the base weapon, crafted at +0. Craft at your Manor's Smithing Station."
        />
        {swagGroups.map(({ base, recipes }) => <section
          key={base.familyId}
          className="crafting-swag-group"
          aria-label={`${base.displayName} swag weapons`}
        >
          <GameAppText as="small" tone="muted" className="crafting-swag-base">{base.displayName}</GameAppText>
          <div className="game-app-card-grid">
            {recipes.map((recipe) => {
              const needs = recipe.materials.map(({ itemId, quantity }) => ({
                itemId,
                quantity,
                name: INVENTORY_CATALOG[itemId]?.displayName ?? itemId,
                have: props.hasSnapshot ? quantities.get(itemId) ?? 0 : null
              }));
              const ready = props.hasSnapshot && needs.every(({ quantity, have }) => (have ?? 0) >= quantity);
              return <GameAppCard
                key={recipe.definitionId}
                title={recipe.displayName}
                className="phone-build-card"
                leading={<ItemArtwork itemId={recipe.definitionId} label={recipe.displayName} />}
                status={<CraftStatusMark ready={ready} verb="craft" />}
                description={`Swag ${base.displayName}`}
              >
                <MaterialChips label={`${recipe.displayName} materials`} materials={needs} />
              </GameAppCard>;
            })}
          </div>
        </section>)}
      </section> : null}
    </div>
  </GameAppShell>;
}
