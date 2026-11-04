import {
  INSCRIBE_LUMEN_COST,
  INSCRIBE_MIN_ITEM_LEVEL,
  INSCRIPTION_NAME_MAX,
  inscriptionKind,
  inscriptionStatRows,
  normalizeInscriptionName,
  BITTER_BLOOD_POISON_DAMAGE_REQUIRED,
  EQUIPMENT_METAL_IDS,
  METAL_BARS_PER_INFUSION,
  ENCHANTMENT_STONE_VARIANTS,
  METAL_REFORGE_BARS_RETURNED,
  jewelReforgeLumenCost,
  equipmentEffectDisplayName,
  equipmentMetalCraftable,
  equipmentMetalDefinition,
  equipmentMetalDisplayName,
  metalInfusionKind,
  parseEquipmentEnhancement,
  requireEquipmentDefinition,
  supportsJewelStationEnhancement,
  type EnchantmentStoneVariant,
  type EquipmentMetal,
  type JewelStationState,
  type MetalProcChance
} from "@ash-atlas/shared";
import { useMemo, useState } from "react";

import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { GameAppActionBar, GameAppButton, GameAppCard, GameAppSectionHeader, GameAppShell } from "./GameAppShell.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChips } from "./MaterialRequirements.js";

type ImbuementMetal = EquipmentMetal;

export function JewelStationPanel(props: Readonly<{
  open: boolean;
  state: JewelStationState | null;
  feedback: string | null;
  busy: boolean;
  online: boolean;
  layout: "desktop" | "phone";
  onImbue(instanceId: string, metal: ImbuementMetal): void;
  onReforge(instanceId: string, options: { gemstone?: EnchantmentStoneVariant; changeMetal: boolean }): void;
  onInscribe(instanceId: string, name: string): void;
  onRetry(): void;
  onClose(): void;
}>): React.JSX.Element | null {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ReforgeChoice | "imbue" | "inscribe" | null>(null);
  const [inscriptionName, setInscriptionName] = useState("");
  const [gemChoice, setGemChoice] = useState<EnchantmentStoneVariant | "">("");
  const [metal, setMetal] = useState<ImbuementMetal>("venomsteel");
  const items = useMemo(() => props.state?.equipment.instances.filter((item) => {
    if (item.location !== "inventory") return false;
    const definition = requireEquipmentDefinition(item.definitionId);
    if (!supportsJewelStationEnhancement(definition)) return false;
    const parsed = parseEquipmentEnhancement(item.enchantmentIdentity);
    if (item.enchantmentIdentity !== null && parsed === null) return false;
    // Metal-bearing items stay listed (for Reforge); new infusions need an infusable slot.
    return parsed?.metal ? true : metalInfusionKind(definition.category) !== null;
  }) ?? [], [props.state]);
  const selected = items.find((item) => item.instanceId === selectedId) ?? items[0] ?? null;
  const definition = selected ? requireEquipmentDefinition(selected.definitionId) : null;
  const imbuementKind: "weapon" | "armor" | null = !definition
    ? null
    : definition.category === "melee_weapon" || definition.category === "ranged_weapon"
      ? "weapon"
      : "armor";
  const enhancement = parseEquipmentEnhancement(selected?.enchantmentIdentity ?? null);
  const infusedMetal = enhancement?.metal ?? null;
  const totals = props.state?.inventory.totals;
  const poisonProgress = props.state?.achievements.achievements.find(
    (achievement) => achievement.achievementId === "bitter_blood"
  );
  const metalDefinition = equipmentMetalDefinition(metal);
  const barsOwned = totals?.[metalDefinition.barItemId] ?? 0;
  const coreId = metalDefinition.legacyCoreItemId;
  const coresOwned = coreId ? totals?.[coreId] ?? 0 : 0;
  const hasMaterials = coresOwned >= 1 || barsOwned >= METAL_BARS_PER_INFUSION;
  const venomLocked = metal === "venomsteel" && poisonProgress?.completed !== true;
  const canImbue = Boolean(selected && infusedMetal === null && hasMaterials && !venomLocked);
  const lumenHave = totals?.lumen ?? 0;
  const currentGem = enhancement?.gemstone ?? null;
  const stoneCounts = new Map<string, number>();
  for (const entry of props.state?.inventory.items ?? []) {
    if (entry.resourceType === "enchantment_stone" && entry.variant) {
      stoneCounts.set(entry.variant, (stoneCounts.get(entry.variant) ?? 0) + entry.quantity);
    }
  }
  const gemOptions = ENCHANTMENT_STONE_VARIANTS.filter(
    (variant) => variant !== currentGem && (stoneCounts.get(variant) ?? 0) >= 1
  );
  const pickedGem = gemChoice !== "" && gemOptions.includes(gemChoice) ? gemChoice : null;
  const reforgeAvailable = (choice: ReforgeChoice): boolean => {
    if (!selected) return false;
    const changeMetal = choice !== "gem";
    const changeGem = choice !== "metal";
    if (changeMetal && infusedMetal === null) return false;
    if (changeGem && (currentGem === null || pickedGem === null)) return false;
    return lumenHave >= jewelReforgeLumenCost(changeMetal, changeGem);
  };
  const reforgeChoices = (["metal", "gem", "both"] as const).filter(reforgeAvailable);
  const canReforge = (choice: ReforgeChoice): boolean => reforgeAvailable(choice);
  const actionStatus = !props.online
    ? "Reconnect to use the Jewel Station"
    : !selected
      ? "Carry an unequipped ordinary weapon, chest armor or shield"
      : infusedMetal !== null
        ? `${METAL_REFORGE_BARS_RETURNED} bars return when the metal is changed`
        : venomLocked
          ? "Bitter Blood is required before infusing Venom"
          : !hasMaterials
            ? `Need ${METAL_BARS_PER_INFUSION} ${equipmentMetalDisplayName(metal)} Bars`
            : coresOwned >= 1
              ? `1 ${equipmentMetalDisplayName(metal)} Core will be consumed`
              : `${METAL_BARS_PER_INFUSION} ${equipmentMetalDisplayName(metal)} Bars will be consumed`;

  const inscribable = Boolean(selected && inscriptionKind(selected.category) !== null &&
    selected.itemLevel >= INSCRIBE_MIN_ITEM_LEVEL);
  const typedName = normalizeInscriptionName(inscriptionName);
  const canInscribe = inscribable && typedName !== null && lumenHave >= INSCRIBE_LUMEN_COST;

  const confirm = (): void => {
    if (!selected || !confirming) return;
    const action = confirming;
    setConfirming(null);
    if (action === "inscribe") {
      if (canInscribe && typedName) props.onInscribe(selected.instanceId, typedName);
      return;
    }
    if (action !== "imbue") {
      if (canReforge(action)) {
        props.onReforge(selected.instanceId, {
          ...(action !== "metal" && pickedGem ? { gemstone: pickedGem } : {}),
          changeMetal: action !== "gem"
        });
      }
    } else if (canImbue) {
      props.onImbue(selected.instanceId, metal);
    }
  };

  return <>
    <GameAppShell
      open={props.open}
      title="Jewel Station"
      subtitle="Infuse a weapon, chest armor or shield with metal bars. Infusion is permanent."
      closeLabel="Close Jewel Station"
      className="jewel-station-app"
      layout={props.layout}
      phoneBackLabel="Back to Manor"
      phoneOnReturnToGame={props.onClose}
      closeDisabled={props.busy}
      onClose={props.onClose}
      footer={props.state ? <GameAppActionBar>
        <small>{actionStatus}</small>
        {infusedMetal === null ? <GameAppButton
          variant="primary"
          disabled={props.busy || !props.online || !selected || !canImbue}
          onClick={() => setConfirming("imbue")}
        >{`Infuse with ${equipmentMetalDisplayName(metal)}`}</GameAppButton> : null}
        {inscribable ? <GameAppButton
          disabled={props.busy || !props.online || !canInscribe}
          onClick={() => setConfirming("inscribe")}
        >{`Inscribe (${INSCRIBE_LUMEN_COST} Lumen)`}</GameAppButton> : null}
        {reforgeChoices.map((choice) => <GameAppButton
          key={choice}
          variant={choice === "metal" ? "primary" : "standard"}
          disabled={props.busy || !props.online}
          onClick={() => setConfirming(choice)}
        >{reforgeLabel(choice)}</GameAppButton>)}
      </GameAppActionBar> : undefined}
    >
      <div className="jewel-station-workspace">
        {props.feedback ? <p className="jewel-station-status" role="alert">{props.feedback}</p> : null}
        {!props.state ? <GameAppCard
          title={props.feedback ? "Jewel Station unavailable" : "Preparing Jewel Station"}
          badge={props.online ? "Loading" : "Offline"}
        >
          <p className="jewel-station-empty-copy">
            {props.feedback ?? (props.online ? "Checking your equipment and materials…" : "Reconnect to use the station.")}
          </p>
          {props.online ? <GameAppButton onClick={props.onRetry}>Retry</GameAppButton> : null}
        </GameAppCard> : !selected ? <GameAppCard title="No eligible equipment" badge="Empty">
          <p className="jewel-station-empty-copy">Carry an unequipped ordinary weapon, chest armor or shield.</p>
        </GameAppCard> : <>
          <nav className="jewel-equipment-tabs" aria-label="Eligible equipment">
            {items.map((item) => {
              const itemEnhancement = parseEquipmentEnhancement(item.enchantmentIdentity);
              return <button
                key={item.instanceId}
                type="button"
                aria-pressed={item.instanceId === selected.instanceId}
                disabled={props.busy}
                onClick={() => { setSelectedId(item.instanceId); setConfirming(null); setGemChoice(""); }}
              >
                <ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />
                <span><strong>{item.displayName}</strong><small>{stageLabel(itemEnhancement)}</small></span>
              </button>;
            })}
          </nav>
          <GameAppCard title={selected.displayName} badge={stageLabel(enhancement)}>
            <div className="jewel-station-detail">
              <div className="jewel-output-summary">
                <ItemArtwork itemId={selected.definitionId} category={selected.category} label={selected.displayName} />
                <div>
                  <span>Selected equipment</span>
                  <strong>{selected.displayName}</strong>
                  <small>{imbuementKind === "weapon" ? "Weapon infusion" : "Armor infusion"}</small>
                </div>
              </div>
              {infusedMetal === null ? <>
                <label>Metal
                  <select value={metal} disabled={props.busy} onChange={(event) => setMetal(event.target.value as ImbuementMetal)}>
                    {EQUIPMENT_METAL_IDS.map((value) => {
                      const metalOption = equipmentMetalDefinition(value);
                      return <option key={value} value={value}>
                        {metalOption.displayName} ({totals?.[metalOption.barItemId] ?? 0} bars)
                      </option>;
                    })}
                  </select>
                </label>
                <section className="jewel-materials" aria-label="Materials">
                  <GameAppSectionHeader title="Materials" meta={<CraftStatusMark ready={hasMaterials} verb="craft" />} />
                  <MaterialChips
                    label={`${metalDefinition.displayName} Bar material`}
                    materials={[{
                      itemId: metalDefinition.barItemId,
                      name: `${metalDefinition.displayName} Bar`,
                      quantity: METAL_BARS_PER_INFUSION,
                      have: barsOwned
                    }]}
                  />
                  {coreId ? <small>A legacy {metalDefinition.displayName} Core ({coresOwned} owned) can be used instead.</small> : null}
                  {!equipmentMetalCraftable(metal) ? <small>Skyrise Bars cannot be forged until Zephyr exists.</small> : null}
                </section>
                <EffectPreview kind={imbuementKind} metal={metal} />
                <p className="jewel-station-note">Infusion is permanent. A gemstone already on the item is kept.</p>
                <GemPicker current={currentGem} options={gemOptions} counts={stoneCounts} value={pickedGem} disabled={props.busy} onChange={setGemChoice} />
              </> : <>
                <EffectPreview kind={imbuementKind} metal={infusedMetal} />
                <dl className="game-app-stats jewel-station-facts">
                  {enhancement?.gemstone ? <div><dt>Gemstone</dt><dd>{capitalize(enhancement.gemstone)}</dd></div> : null}
                  {infusedMetal === "venomsteel"
                    ? <div><dt>Bitter Blood</dt><dd>{poisonProgress?.value ?? 0} / {BITTER_BLOOD_POISON_DAMAGE_REQUIRED}</dd></div>
                    : null}
                </dl>
                <p className="jewel-station-note">{infusedMetal === "venomsteel" && !poisonProgress?.completed
                  ? "Take 250 poison damage to unlock Bitter Blood and equip this item. "
                  : ""}Changing the metal costs {jewelReforgeLumenCost(true, false)} Lumen and returns {METAL_REFORGE_BARS_RETURNED} {equipmentMetalDisplayName(infusedMetal)} Bars.</p>
                <GemPicker current={currentGem} options={gemOptions} counts={stoneCounts} value={pickedGem} disabled={props.busy} onChange={setGemChoice} />
              </>}
              {inscribable ? <section className="jewel-inscription" aria-label="Inscription">
                <GameAppSectionHeader title="Inscription" />
                {selected.inscription ? <>
                  <strong>{selected.inscription.name}</strong>
                  <small>Inscribed by {selected.inscription.inscriberName}</small>
                  <dl className="game-app-stats">
                    {inscriptionStatRows(selected.inscription).map(([label, value]) =>
                      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                  </dl>
                </> : null}
                <label>Name
                  <input
                    type="text"
                    value={inscriptionName}
                    maxLength={INSCRIPTION_NAME_MAX}
                    disabled={props.busy}
                    onChange={(event) => setInscriptionName(event.target.value)}
                  />
                </label>
              </section> : null}
            </div>
          </GameAppCard>
        </>}
      </div>
    </GameAppShell>
    {confirming === "inscribe" && selected ? <GameConfirmationPrompt
      title={`Inscribe ${selected.displayName}?`}
      detail={`Spend ${INSCRIBE_LUMEN_COST} Lumen to name it "${typedName ?? ""}". Anyone can inscribe it again later; its stats stay.`}
      confirmLabel="Inscribe"
      confirmEnabled={canInscribe}
      busy={props.busy}
      onCancel={() => setConfirming(null)}
      onConfirm={confirm}
    /> : null}
    {confirming && confirming !== "inscribe" && selected ? <GameConfirmationPrompt
      title={confirming !== "imbue" ? `Reforge ${selected.displayName}?` : `Infuse ${selected.displayName}?`}
      detail={confirming !== "imbue"
        ? reforgeDetail(confirming, pickedGem)
        : `${coresOwned >= 1 ? `Consume one legacy ${equipmentMetalDisplayName(metal)} Core.` : `Consume ${METAL_BARS_PER_INFUSION} ${equipmentMetalDisplayName(metal)} Bars.`} Infusion is permanent.${metal === "venomsteel" ? " Bitter Blood is required to equip Venom gear." : ""}`}
      confirmLabel={confirming !== "imbue" ? reforgeLabel(confirming) : `Infuse ${equipmentMetalDisplayName(metal)}`}
      confirmEnabled={confirming !== "imbue" ? canReforge(confirming) : canImbue}
      busy={props.busy}
      onCancel={() => setConfirming(null)}
      onConfirm={confirm}
    /> : null}
  </>;
}

type ReforgeChoice = "metal" | "gem" | "both";

function reforgeLabel(choice: ReforgeChoice): string {
  const cost = jewelReforgeLumenCost(choice !== "gem", choice !== "metal");
  const name = choice === "metal" ? "Change Metal" : choice === "gem" ? "Change Gem" : "Change Both";
  return `${name} (${cost} Lumen)`;
}

function reforgeDetail(choice: ReforgeChoice, gem: EnchantmentStoneVariant | null): string {
  const cost = jewelReforgeLumenCost(choice !== "gem", choice !== "metal");
  const parts = [`Spend ${cost} Lumen.`];
  if (choice !== "gem") parts.push(`The metal is stripped and ${METAL_REFORGE_BARS_RETURNED} bars return.`);
  if (choice !== "metal" && gem) parts.push(`1 ${capitalize(gem)} Enchantment Stone is consumed; the old gem is lost.`);
  return parts.join(" ");
}

function GemPicker(props: Readonly<{
  current: EnchantmentStoneVariant | null;
  options: readonly EnchantmentStoneVariant[];
  counts: ReadonlyMap<string, number>;
  value: EnchantmentStoneVariant | null;
  disabled: boolean;
  onChange(value: EnchantmentStoneVariant | ""): void;
}>): React.JSX.Element | null {
  if (!props.current || props.options.length === 0) return null;
  return <label>New gem ({capitalize(props.current)} now)
    <select
      value={props.value ?? ""}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value as EnchantmentStoneVariant | "")}
    >
      <option value="">Keep current gem</option>
      {props.options.map((variant) => <option key={variant} value={variant}>
        {capitalize(variant)} ({props.counts.get(variant) ?? 0} stones)
      </option>)}
    </select>
  </label>;
}

function formatProc(proc: MetalProcChance): string {
  if (proc.kind === "fixed") return `${Math.round(proc.chance * 100)}% chance`;
  if (proc.kind === "missing_hp") return "chance rises as the opponent loses health";
  return "triggers on a kill or a death";
}

function EffectPreview(props: Readonly<{
  kind: "weapon" | "armor" | null;
  metal: ImbuementMetal;
}>): React.JSX.Element {
  const definition = equipmentMetalDefinition(props.metal);
  const proc = props.kind === "weapon" ? definition.weapon : definition.armor;
  return <div className="jewel-effect-preview">
    <span>{definition.displayName} effect</span>
    <strong>{equipmentEffectDisplayName(definition.effect)}</strong>
    <small>{props.kind === "weapon" ? "Weapon: " : "Armor: "}{formatProc(proc)}.</small>
  </div>;
}

function stageLabel(enhancement: ReturnType<typeof parseEquipmentEnhancement>): string {
  if (!enhancement) return "Ordinary";
  return enhancement.metal
    ? `${equipmentMetalDisplayName(enhancement.metal)} / ${enhancement.effect ? equipmentEffectDisplayName(enhancement.effect) : "Infused"}`
    : `${capitalize(enhancement.gemstone ?? "none")} prepared`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
