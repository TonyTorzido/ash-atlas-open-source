import {
  EQUIPMENT_METAL_IDS,
  equipmentMetalDisplayName,
  type EquipmentMetal,
  GRANTABLE_RESOURCE_CATALOG,
  CREATURE_BOOK_ROSTER,
  PLANT_BOOK_ROSTER,
  MOB_ARCHETYPE_KEYS,
  DUNGEON_CATALOG,
  LUMEN_ITEM_ID,
  PREMIUM_CURRENCIES,
  PREMIUM_CURRENCY_NAMES,
  developerDungeonEntranceTemplates,
  type ActiveGoblinVillageSnapshot,
  type DeveloperCapitalFoundingPlan,
  type DeveloperTestFlagKind,
  type DeveloperTestUnitType,
  type DungeonEntranceSnapshot,
  type MobArchetypeKey,
  type MobAppearanceVariant,
  type PlantBookKey,
  type PlayerInventorySnapshot,
  type PremiumCurrency,
  type PremiumWalletSnapshot,
  type InventoryItemType
} from "@ash-atlas/shared";
import { lazy, Suspense, useEffect, useState } from "react";

import { isPerfProbeEnabled, isPerfProbeVisible, setPerfProbeEnabled } from "../perf/perfProbe.js";
import { cameraSnapMode, overlayWalkMode, setCameraSnapMode, setOverlayWalkMode, setStaticFollowMode, staticFollowMode } from "../map/followSwitches.js";
import { rasterAlignmentMode, setRasterAlignmentMode, type RasterAlignmentMode } from "../map/rasterAlignment.js";
import { cameraDriverMode, cameraFilterMode, setCameraDriverMode, setCameraFilterMode } from "../map/cameraDriverMode.js";
import { isLegacyRenderQualityEnabled, isReducedRenderQualityEnabled, setLegacyRenderQualityEnabled, setReducedRenderQualityEnabled } from "../perf/renderQualityFlag.js";
import { useModalBehavior } from "./useModalBehavior.js";
import { DeveloperPackagesPanel } from "./DeveloperPackagesPanel.js";
import { DeveloperShopCatalogPanel } from "./DeveloperShopCatalogPanel.js";
import { DeveloperLeaderboardsPanel } from "./DeveloperLeaderboardsPanel.js";
import { DeveloperEconomyObservatory } from "./DeveloperEconomyObservatory.js";
import { DeveloperLegendaryBirdPanel } from "./DeveloperLegendaryBirdPanel.js";
import { DeveloperAnnouncementsPanel } from "./DeveloperAnnouncementsPanel.js";
import { DeveloperBugReportsPanel } from "./DeveloperBugReportsPanel.js";
const DeveloperPngLab = lazy(() => import("./DeveloperPngLab.js").then((module) => ({ default: module.DeveloperPngLab })));
import { UiStandardsGallery } from "./UiStandardsGallery.js";
import { CurrencyGlyph } from "./InventoryCarryList.js";
import type maplibregl from "maplibre-gl";
import type { DevPngLabController } from "../developer/devPngLabController.js";
import type { DeveloperCapitalFoundingState } from "../features/developer/useDeveloperCapitalFounding.js";
import type { PresentationPreview } from "../uiEnvironment.js";

export const DEV_MATERIALS = GRANTABLE_RESOURCE_CATALOG.map(
  (item) => item.itemId as InventoryItemType
);
const DEV_SPAWN_EXCLUDED_ARCHETYPES = new Set<MobArchetypeKey>([
  "goblin",
  "bandit",
  "hollin_guard",
  "hollin_brute",
  "hollin_elder",
  "hollin_farmer",
  "hollin_helper"
]);
type Tab = "admin" | "economy" | "shop" | "greenhouse" | "packages" | "leaderboards" | "world" | "spawning" | "png-lab" | "mines" | "bug-reports" | "ui-standards" | "developer-view" | "diagnostics";

const TOOL_META: Record<Tab, { label: string; description: string }> = {
  admin: { label: "Admin", description: "Test access, account trust, announcements" },
  economy: { label: "Economy", description: "Grant gold, currencies, materials, metals, city coins" },
  shop: { label: "Shop catalog", description: "Glimmer Shop source, price, featured, on sale, new" },
  greenhouse: { label: "Greenhouse", description: "Advance and water crops in your Greenhouse" },
  packages: { label: "Packages", description: "Send item packages to players" },
  leaderboards: { label: "Leaderboards", description: "Private leaderboard views" },
  world: { label: "World", description: "Teleport, found a capital, collapse territory" },
  spawning: { label: "Spawning", description: "Mobs, plants, military targets, dungeon entrances" },
  "png-lab": { label: "PNG Lab", description: "Place and tune map art instances" },
  mines: { label: "Permanent Mines", description: "Search mines and travel to them" },
  "bug-reports": { label: "Bug Reports", description: "Player-submitted bug reports" },
  "ui-standards": { label: "UI Standards", description: "Production component gallery" },
  "developer-view": { label: "Developer View", description: "Overlays, diagnostics toggles, presentation preview" },
  diagnostics: { label: "Diagnostics", description: "Console, latency trace, progression and pet tools" }
};
const TOOL_GROUPS: readonly { id: string; label: string; tabs: readonly Tab[] }[] = [
  { id: "moderation", label: "Social & Moderation", tabs: ["admin", "bug-reports"] },
  { id: "economy", label: "Items & Economy", tabs: ["economy", "shop", "packages", "leaderboards"] },
  { id: "world", label: "World & Mobs", tabs: ["world", "spawning", "mines", "greenhouse", "png-lab"] },
  { id: "diagnostics", label: "Diagnostics & View", tabs: ["developer-view", "diagnostics", "ui-standards"] }
];
const COLLAPSED_GROUPS_KEY = "ash-atlas.developer-tools.collapsed-groups";
function readCollapsedGroups(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}
function writeCollapsedGroups(groups: readonly string[]): void {
  try { window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(groups)); } catch { /* storage unavailable */ }
}

type PermanentMine = {
  id: string; lat: number; lon: number; state: "ready" | "depleted"; remainingMs: number;
  canonicalState: "ready" | "harvested" | "dead" | "missing";
  canonicalLifecycleValid: boolean;
  projectionState: "ready" | "depleted";
  canonicalRevision: number | null; projectionRevision: number;
  harvestRevision: number; lifecycleMismatch: boolean;
  placementBucketKey: string; placementVersion: string; regionCode: string;
  worldPackageId: string | null; worldEcoregion: string | null;
  coveringFlag: { id: string; name: string; distanceM: number } | null; coveringFlagCount: number;
};

type Props = {
  open: boolean; developerAccessEnabled: boolean; developerObserveEnabled?: boolean; worldMutationEnabled?: boolean; assetGrantEnabled?: boolean; economyMutationEnabled?: boolean; packageSendEnabled?: boolean; privateLeaderboardsEnabled?: boolean; testAccessManageEnabled?: boolean;
  inventory: PlayerInventorySnapshot; walletGold: string | null;
  premiumBalances?: PremiumWalletSnapshot["balances"] | null; busy: boolean; feedback: string | null;
  greenhouseInside?: boolean;
  onAdvanceAllGreenhouseCrops?(): void;
  onBuildDevManor?(): void;
  onBuildDevSalon?(): void;
  onWaterAllGreenhouseCrops?(): void;
  onGrantMetalEquipment?(kind: "sword" | "chest", metal: EquipmentMetal): void;
  cityTreasury?: { cityName: string; treasuryBalance: string; playerContribution: string } | null;
  resourceVisionEnabled: boolean; combatDiagnosticsEnabled: boolean;
  /** Dev-only hurt circle overlay (optional so older callers keep compiling). */
  hurtCirclesEnabled?: boolean; onHurtCirclesChange?(enabled: boolean): void;
  movementDiagnosticsEnabled: boolean; geographyDiagnosticsEnabled: boolean;
  mobileDiagnosticsEnabled: boolean; performanceEnabled: boolean; zoomIndicatorEnabled: boolean;
  zoomIndicatorAvailable: boolean;
  revealAllClassesEnabled?: boolean;
  onRevealAllClassesChange?(enabled: boolean): void;
  legacyIndoorDungeonEnabled?: boolean;
  onLegacyIndoorDungeonChange?(enabled: boolean): void;
  presentationPreview?: PresentationPreview;
  onPresentationPreviewChange?(value: PresentationPreview): void;
  activeArchetype: MobArchetypeKey | null;
  activePlantKey?: PlantBookKey | null;
  activeMilitarySpawn?: DeveloperTestFlagKind | DeveloperTestUnitType | null;
  activeAppearanceVariant?: MobAppearanceVariant;
  onClose(): void; onGrantGold(quantity: number): void; onGrantCityCoins(quantity: number): void;
  onGrantPremiumCurrency?(currency: PremiumCurrency | typeof LUMEN_ITEM_ID, quantity: number): void; onGrantMaterial(item: InventoryItemType, quantity: number): void;
  onGrantTestKit(): void; onResourceVisionChange(enabled: boolean): void;
  onCombatDiagnosticsChange(enabled: boolean): void; onMovementDiagnosticsChange(enabled: boolean): void;
  onGeographyDiagnosticsChange(enabled: boolean): void; onMobileDiagnosticsChange(enabled: boolean): void;
  onPerformanceChange(enabled: boolean): void; onZoomIndicatorChange(enabled: boolean): void;
  onDisableViews(): void; onChooseMob(archetype: MobArchetypeKey, appearanceVariant: MobAppearanceVariant): void;
  onChoosePlant?(plantKey: PlantBookKey): void;
  onChooseMilitaryTestFlag?(targetKind: DeveloperTestFlagKind): void;
  onChooseMilitaryTestUnit?(unitType: DeveloperTestUnitType): void;
  onChooseGoblinVillage?(): void;
  /** Spawns a Hollin Hut at the player's position (the Beasts list's Hollin Hut places one at a tapped point). */
  onSpawnHollinHutHere?(): void;
  goblinVillages?: readonly ActiveGoblinVillageSnapshot[];
  goblinVillagesLoading?: boolean;
  goblinVillageDeleteBusy?: boolean;
  onRequestGoblinVillages?(): void;
  onDeleteGoblinVillage?(village: ActiveGoblinVillageSnapshot): void;
  capitalFounding?: DeveloperCapitalFoundingState;
  onCollapseTerritory?: ((kind: "city" | "kingdom") => void) | undefined;
  onPlanCapital?(): void;
  onConfirmCapital?(): void;
  onCapitalLeaveChange?(leave: boolean): void;
  developerDungeonEntrances?: readonly DungeonEntranceSnapshot[];
  developerDungeonEntrancesLoading?: boolean;
  developerDungeonEntranceDeleteBusy?: boolean;
  onRequestDungeonEntrances?(): void;
  onChooseDungeonEntrance?(templateId: string): void;
  onDeleteDungeonEntrance?(entrance: DungeonEntranceSnapshot): void;
  onClearMobs(): void; onClearPlants?(): void; onResetDungeonRun?(): void; onCancelSpawning(): void; onOpenConsole(): void;
  onOpenProgression(): void;
  onResetClassAbilityCooldowns(): void;
  /** Gives every pet whistle with both abilities, ready to call. */
  onGrantAllPets?(): void;
  onResetSkillTreeV3?(): void;
  skillTreeResetBusy?: boolean;
  onOpenTestAccess?(): void;
  onOpenTrustAdmin?(): void;
  announcementsManageEnabled?: boolean;
  onOpenGameplayLatencyTrace?(): void;
  selectedFlagName?: string; onOpenFlagDiagnostics?(): void;
  teleportActive?: boolean; onTeleport?(): void;
  serverHttpBase?: string; csrfToken?: string; onVisitMine?(mineId: string): void;
  pngLabController?: DevPngLabController;
  mapZoom?: number;
  map?: maplibregl.Map | null;
  playerPosition?: Readonly<{ longitude: number; latitude: number }> | null;
  onStartPngPlacement?(): void;
  onCenterPngPlacement?(longitude: number, latitude: number): void;
};

export function DeveloperToolsPanel(props: Props): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>(() =>
    props.developerObserveEnabled === false ? "admin" : "developer-view"
  );
  const [gold, setGold] = useState(1_000);
  const [cityCoins, setCityCoins] = useState(1_000);
  const [premiumAmount, setPremiumAmount] = useState(1_000);
  const [material, setMaterial] = useState<InventoryItemType>("wood");
  const [quantity, setQuantity] = useState(500);
  const [mineSearch, setMineSearch] = useState("");
  const [mineState, setMineState] = useState<"all" | "ready" | "depleted">("all");
  const [minePage, setMinePage] = useState(1);
  const [mines, setMines] = useState<PermanentMine[]>([]);
  const [mineTotal, setMineTotal] = useState(0);
  const [mineLoading, setMineLoading] = useState(false);
  const [mineError, setMineError] = useState<string | null>(null);
  const [mineRefresh, setMineRefresh] = useState(0);
  const [economyObservatoryOpen, setEconomyObservatoryOpen] = useState(false);
  const panelRef = useModalBehavior<HTMLDivElement>({ open: props.open && props.developerAccessEnabled, onClose: props.onClose });
  const economyVisible = Boolean(
    props.developerObserveEnabled || props.assetGrantEnabled || props.economyMutationEnabled
  );
  const tabs: Tab[] = [
    ...(props.testAccessManageEnabled || props.announcementsManageEnabled ? ["admin" as const] : []),
    ...(props.developerObserveEnabled === false ? [] : [
      ...(economyVisible ? ["economy" as const] : []),
      ...(props.economyMutationEnabled && props.serverHttpBase && props.csrfToken ? ["shop" as const] : []),
      "greenhouse" as const,
      ...(props.packageSendEnabled ? ["packages" as const] : []),
      ...(props.privateLeaderboardsEnabled ? ["leaderboards" as const] : []),
      ...(props.worldMutationEnabled ? ["world" as const, "spawning" as const] : []),
      "png-lab" as const,
      "mines" as const,
      "bug-reports" as const,
      "ui-standards" as const,
      "developer-view" as const,
      "diagnostics" as const
    ])
  ];
  useEffect(() => {
    if (!props.open) setEconomyObservatoryOpen(false);
  }, [props.open]);
  useEffect(() => {
    if (
      (props.developerObserveEnabled === false && tab !== "admin") ||
      (tab === "admin" && !props.testAccessManageEnabled && !props.announcementsManageEnabled) ||
      (tab === "economy" && !economyVisible) ||
      (tab === "shop" && !props.economyMutationEnabled) ||
      (tab === "packages" && !props.packageSendEnabled) ||
      (tab === "leaderboards" && !props.privateLeaderboardsEnabled) ||
      ((tab === "world" || tab === "spawning") && !props.worldMutationEnabled)
    ) {
      setTab(props.developerObserveEnabled === false ? "admin" : "developer-view");
    }
  }, [economyVisible, tab, props.announcementsManageEnabled, props.developerObserveEnabled, props.packageSendEnabled, props.privateLeaderboardsEnabled, props.testAccessManageEnabled, props.worldMutationEnabled]);
  useEffect(() => {
    if (props.open && props.developerAccessEnabled && tab === "spawning") {
      props.onRequestGoblinVillages?.();
      props.onRequestDungeonEntrances?.();
    }
  }, [props.developerAccessEnabled, props.onRequestDungeonEntrances, props.onRequestGoblinVillages, props.open, tab]);
  useEffect(() => {
    if (!props.open || !props.developerAccessEnabled || tab !== "mines" || !props.serverHttpBase) return;
    const controller = new AbortController();
    setMineLoading(true);
    setMineError(null);
    const url = new URL("/api/dev/permanent-mines", props.serverHttpBase);
    url.searchParams.set("search", mineSearch);
    url.searchParams.set("state", mineState);
    url.searchParams.set("page", String(minePage));
    url.searchParams.set("limit", "25");
    void fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Mine list failed (${response.status})`);
        return response.json() as Promise<{ mines: PermanentMine[]; total: number }>;
      })
      .then((result) => { setMines(result.mines); setMineTotal(result.total); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMineError(error instanceof Error ? error.message : "Mine list failed");
      })
      .finally(() => { if (!controller.signal.aborted) setMineLoading(false); });
    return () => controller.abort();
  }, [minePage, mineRefresh, mineSearch, mineState, props.developerAccessEnabled, props.open, props.serverHttpBase, tab]);
  const [view, setView] = useState<"list" | "tool">("list");
  const [toolSearch, setToolSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups);
  const query = toolSearch.trim().toLowerCase();
  const searching = query.length > 0;
  const visibleGroups = TOOL_GROUPS
    .map((group) => ({
      ...group,
      tabs: group.tabs.filter((value) => tabs.includes(value) && (!searching
        || `${TOOL_META[value].label} ${TOOL_META[value].description} ${group.label}`.toLowerCase().includes(query)))
    }))
    .filter((group) => group.tabs.length > 0);
  const isPhoneProfile = (): boolean => document.documentElement.dataset.uiProfile === "phone";
  const phoneToolOpen = view === "tool" && isPhoneProfile();
  const chooseTab = (value: Tab): void => { setTab(value); setView("tool"); };
  const toggleGroup = (id: string): void => {
    setCollapsedGroups((current) => {
      const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
      writeCollapsedGroups(next);
      return next;
    });
  };
  const handleBack = (): void => {
    if (view === "tool" && isPhoneProfile()) setView("list");
    else props.onClose();
  };
  if (!props.open || !props.developerAccessEnabled) return null;
  return (
    <div className="modal-scrim developer-tools-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section ref={panelRef} tabIndex={-1} className="developer-tools-panel" data-active-tab={tab} data-view={view} role="dialog" aria-modal="true" aria-labelledby="developer-tools-title">
        <header>
          <button type="button" className="dev-tools-back" onClick={handleBack} aria-label={phoneToolOpen ? "Back to Developer tools" : "Close Developer App"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7" /></svg></button>
          <div className="dev-tools-heading"><span className="eyebrow">Owner only</span><h2 id="developer-tools-title">Developer App</h2></div>
          <p className="dev-tools-current" aria-hidden="true">{TOOL_META[tab].label}</p>
        </header>
        <div className="developer-tools-body" data-view={view}>
        <nav aria-label="Developer tool sections">
          <div className="dev-tools-search"><input type="search" value={toolSearch} placeholder="Search tools" aria-label="Search developer tools" onChange={(event) => setToolSearch(event.currentTarget.value)} /></div>
          {visibleGroups.map((group) => {
            const expanded = searching || !collapsedGroups.includes(group.id);
            return <section key={group.id} className="dev-tools-group" aria-label={group.label}>
              <button type="button" className="dev-tools-group-toggle" aria-expanded={expanded} disabled={searching} onClick={() => toggleGroup(group.id)}><span>{group.label}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>
              {expanded ? <div className="dev-tools-group-list">{group.tabs.map((value) => <button key={value} type="button" className={tab === value ? "dev-tools-tool active" : "dev-tools-tool"} aria-current={tab === value ? "page" : undefined} onClick={() => chooseTab(value)}><span>{TOOL_META[value].label}</span><small aria-hidden="true">{TOOL_META[value].description}</small></button>)}</div> : null}
            </section>;
          })}
          {visibleGroups.length === 0 ? <p className="muted dev-tools-empty" role="status">No tools match "{toolSearch.trim()}".</p> : null}
        </nav>
        <div className="developer-tools-main">
        <div className="developer-tools-content">
          {tab === "developer-view" && props.onPresentationPreviewChange ? <DeveloperPresentationControl value={props.presentationPreview ?? "auto"} onChange={props.onPresentationPreviewChange} /> : null}
          {tab === "admin" ? <section className="developer-admin-tools" aria-label="Owner administration"><h3>Owner Administration</h3><p className="muted">Owner-authorized player and closed-test controls.</p>{props.testAccessManageEnabled ? <div className="dev-quick-actions"><button type="button" disabled={!props.onOpenTestAccess} onClick={props.onOpenTestAccess}>Open Test Access</button><button type="button" disabled={!props.onOpenTrustAdmin} onClick={props.onOpenTrustAdmin}>Open Account Trust</button></div> : null}{props.announcementsManageEnabled && props.serverHttpBase && props.csrfToken ? <DeveloperAnnouncementsPanel serverHttpBase={props.serverHttpBase} csrfToken={props.csrfToken} /> : null}</section> : null}
          {tab === "shop" && props.serverHttpBase && props.csrfToken ? <DeveloperShopCatalogPanel serverHttpBase={props.serverHttpBase} csrfToken={props.csrfToken} /> : null}
          {tab === "economy" ? <>
            <section className="developer-economy-section">
              <span className="eyebrow">Wallet</span>
              <div className="dev-current-assets"><strong>Current Gold</strong><span>{props.walletGold ?? "Open Market to load"} Gold</span></div>
              {props.economyMutationEnabled ? <><div className="dev-form"><label>Gold amount<input type="number" min={1} max={1000000} value={gold} onChange={(event) => setGold(event.currentTarget.valueAsNumber)} /></label><button type="button" disabled={props.busy} onClick={() => props.onGrantGold(gold)}>Grant Gold</button></div><div className="dev-quick-actions"><button type="button" disabled={props.busy} onClick={() => props.onGrantGold(1_000)}>+1,000 Gold</button><button type="button" disabled={props.busy} onClick={() => props.onGrantGold(10_000)}>+10,000 Gold</button><button type="button" disabled={props.busy} onClick={props.onGrantTestKit}>Market test kit</button></div></> : null}
            </section>
            {props.economyMutationEnabled && props.onGrantPremiumCurrency ? <section className="developer-economy-section" aria-label="Premium currencies">
              <span className="eyebrow">Premium Currencies</span>
              <div className="dev-current-assets">{PREMIUM_CURRENCIES.map((currency) => <span key={currency}><CurrencyGlyph kind={currency} />{PREMIUM_CURRENCY_NAMES[currency]}: {props.premiumBalances ? BigInt(props.premiumBalances[currency].balance).toLocaleString() : "Loading"}</span>)}</div>
              <p className="muted">Audited admin grant. Glimmer goes to this account; Lumen goes to inventory. There are no other sources of Glimmer or Lumen.</p>
              <div className="dev-form"><label>Amount<input type="number" min={1} max={1000000} value={premiumAmount} onChange={(event) => setPremiumAmount(event.currentTarget.valueAsNumber)} /></label>{PREMIUM_CURRENCIES.map((currency) => <button key={currency} type="button" disabled={props.busy} onClick={() => props.onGrantPremiumCurrency?.(currency, premiumAmount)}>Grant {PREMIUM_CURRENCY_NAMES[currency]}</button>)}<button type="button" disabled={props.busy} onClick={() => props.onGrantPremiumCurrency?.(LUMEN_ITEM_ID, premiumAmount)}>Grant Lumen</button></div>
            </section> : null}
            {props.developerObserveEnabled && props.serverHttpBase ? <section className="developer-economy-section"><span className="eyebrow">Economy Analytics</span><p className="muted">Read-only aggregate supply, flow, concentration, coverage, and session health.</p><div className="dev-quick-actions"><button type="button" onClick={() => setEconomyObservatoryOpen(true)}>Open Economy Observatory</button></div></section> : null}
            <section className="developer-economy-section">
              <span className="eyebrow">Inventory Materials</span>
              <div className="dev-current-assets">{DEV_MATERIALS.map((item) => <span key={item}>{developmentItemName(item)}: {(props.inventory.totals[item] ?? 0).toLocaleString()}</span>)}</div>
              {props.assetGrantEnabled ? <div className="dev-form"><label>Material<select value={material} onChange={(event) => { const next = event.currentTarget.value as InventoryItemType; setMaterial(next); if (next === "fishing_rod") setQuantity(1); }}>{DEV_MATERIALS.map((item) => <option value={item} key={item}>{developmentItemName(item)}</option>)}</select></label><label>Quantity<input type="number" min={1} max={material === "fishing_rod" ? 1 : 1000000} value={quantity} onChange={(event) => setQuantity(event.currentTarget.valueAsNumber)} /></label><button type="button" disabled={props.busy} onClick={() => props.onGrantMaterial(material, quantity)}>Grant material</button></div> : null}
            </section>
            {props.assetGrantEnabled && props.onGrantMetalEquipment ? <section className="developer-economy-section" aria-label="Metals">
              <span className="eyebrow">Metals</span>
              <p className="muted">Grants a stock Sword or chest armor already infused with the metal (no gemstone), for testing weapon and armor procs.</p>
              <div className="dev-quick-actions" aria-label="Metal swords">{EQUIPMENT_METAL_IDS.map((metal) => <button key={`sword-${metal}`} type="button" disabled={props.busy} onClick={() => props.onGrantMetalEquipment?.("sword", metal)}>{equipmentMetalDisplayName(metal)} Sword</button>)}</div>
              <div className="dev-quick-actions" aria-label="Metal chest armor">{EQUIPMENT_METAL_IDS.map((metal) => <button key={`chest-${metal}`} type="button" disabled={props.busy} onClick={() => props.onGrantMetalEquipment?.("chest", metal)}>{equipmentMetalDisplayName(metal)} Armor</button>)}</div>
            </section> : null}
            {props.economyMutationEnabled ? <section className="developer-economy-section">
              <span className="eyebrow">City Treasury</span>
              <div className="dev-current-assets"><strong>{props.cityTreasury?.cityName ?? "Current city"}</strong><span>{props.cityTreasury ? `${BigInt(props.cityTreasury.treasuryBalance).toLocaleString()} City Coins` : "Treasury balance loads after a successful grant"}</span>{props.cityTreasury ? <span>Your contribution: {BigInt(props.cityTreasury.playerContribution).toLocaleString()}</span> : null}</div>
              <p className="muted">City Coins are credited directly to the active character's current city and count as that character's contribution.</p>
              <div className="dev-form"><label>City Coin amount<input type="number" min={1} max={1000000} value={cityCoins} onChange={(event) => setCityCoins(event.currentTarget.valueAsNumber)} /></label><button type="button" disabled={props.busy} onClick={() => props.onGrantCityCoins(cityCoins)}>Grant City Coins</button></div>
            </section> : null}
            {props.feedback ? <p role="status" className="dev-feedback">{props.feedback}</p> : null}
          </> : null}
          {tab === "greenhouse" ? <section className="developer-economy-section" aria-label="Greenhouse test controls">
            <span className="eyebrow">Test-only controls</span>
            <h3>Greenhouse</h3>
            <p className="muted">These controls affect only your owned Greenhouse while you are inside. They do not consume water, create plants, award items, or harvest crops.</p>
            <div className="dev-quick-actions">
              <button type="button" disabled={!props.greenhouseInside || !props.onAdvanceAllGreenhouseCrops} onClick={props.onAdvanceAllGreenhouseCrops}>Advance All Crops One Stage</button>
              <button type="button" disabled={!props.greenhouseInside || !props.onWaterAllGreenhouseCrops} onClick={props.onWaterAllGreenhouseCrops}>Water All Crops</button>
            </div>
            {!props.greenhouseInside ? <p className="muted" role="status">Enter your owned Greenhouse to enable these controls.</p> : null}
            <h3>Dev Manor</h3>
            <p className="muted">Builds your manor where you stand with no territory or wood needed (Developer only). Walk to its marker and use the doorway to enter.</p>
            <div className="dev-quick-actions">
              <button type="button" disabled={!props.onBuildDevManor} onClick={props.onBuildDevManor}>Grant dev manor here</button>
            </div>
            <h3>Dev Salon</h3>
            <p className="muted">Places an active Salon near you inside the city you stand in (Developer only; no Mayor, materials or build time). If the city already has one, it is kept. Tap its marker to enter.</p>
            <div className="dev-quick-actions">
              <button type="button" disabled={!props.onBuildDevSalon} onClick={props.onBuildDevSalon}>Grant dev salon here</button>
            </div>
            {props.feedback ? <p role="status" className="dev-feedback">{props.feedback}</p> : null}
          </section> : null}
          {tab === "packages" ? <DeveloperPackagesPanel serverHttpBase={props.serverHttpBase} csrfToken={props.csrfToken} /> : null}
          {tab === "leaderboards" && props.serverHttpBase ? <DeveloperLeaderboardsPanel serverHttpBase={props.serverHttpBase} /> : null}
          {tab === "world" ? <><div className="dev-quick-actions"><button type="button" className={props.teleportActive ? "active" : undefined} onClick={props.onTeleport}>{props.teleportActive ? "Cancel Teleport" : "Teleport"}</button></div><p className="muted">Choose Teleport, then click one destination on the map.</p>{props.capitalFounding ? <CapitalFoundingSection state={props.capitalFounding} onPlan={props.onPlanCapital} onConfirm={props.onConfirmCapital} onLeaveChange={props.onCapitalLeaveChange} /> : null}{props.worldMutationEnabled && props.onCollapseTerritory ? <section aria-label="Territory collapse"><h3>Territory collapse</h3><p className="muted">Ends your current city or kingdom at once. Every one of its flags breaks in a wave outward from the seat. This cannot be undone.</p><div className="dev-quick-actions"><button type="button" className="danger-action" onClick={() => props.onCollapseTerritory?.("city")}>Collapse my city</button><button type="button" className="danger-action" onClick={() => props.onCollapseTerritory?.("kingdom")}>Collapse my kingdom</button></div></section> : null}</> : null}
           {tab === "spawning" ? <><p className="muted">Choose a target, then click a valid map position. Server spawn safeguards remain authoritative.</p><h3>Plants</h3><div className="dev-mob-grid">{PLANT_BOOK_ROSTER.map((plant) => <button type="button" key={plant.plantKey} className={props.activePlantKey === plant.plantKey ? "active" : undefined} onClick={() => props.onChoosePlant?.(plant.plantKey)}>{plant.name}</button>)}</div>{props.onClearPlants ? <button type="button" className="danger-action" onClick={props.onClearPlants}>Clear plants</button> : null}<section aria-label="Military test targets"><h3>Military test targets</h3><p className="muted">Stage canonical Flag tiers for the developer military paths.</p><div className="dev-mob-grid"><button type="button" className={props.activeMilitarySpawn === "soft_flag" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestFlag?.("soft_flag")}>Spawn Test Soft Flag</button><button type="button" className={props.activeMilitarySpawn === "bastion_flag" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestFlag?.("bastion_flag")}>Spawn Test Bastion Flag</button><button type="button" className={props.activeMilitarySpawn === "tower" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestFlag?.("tower")}>Spawn Test Tower</button></div></section><section aria-label="Military test units"><h3>Military test units</h3><p className="muted">Each click stages one unit at the selected map coordinate. Sieges spawn packed and must be deployed explicitly.</p><div className="dev-mob-grid"><button type="button" className={props.activeMilitarySpawn === "field_ballista" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestUnit?.("field_ballista")}>Spawn Siege</button><button type="button" className={props.activeMilitarySpawn === "bomber" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestUnit?.("bomber")}>Spawn Bomber</button><button type="button" className={props.activeMilitarySpawn === "archer" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestUnit?.("archer")}>Spawn Archer</button><button type="button" className={props.activeMilitarySpawn === "infantry" ? "active" : undefined} onClick={() => props.onChooseMilitaryTestUnit?.("infantry")}>Spawn Melee Kippin</button></div></section><h3>Beasts</h3><div className="dev-mob-grid">{props.onChooseGoblinVillage ? <button type="button" onClick={props.onChooseGoblinVillage}>Goblin Village</button> : null}{props.onSpawnHollinHutHere ? <button type="button" onClick={props.onSpawnHollinHutHere}>Hollin Hut here</button> : null}{MOB_ARCHETYPE_KEYS.filter((mob) => !DEV_SPAWN_EXCLUDED_ARCHETYPES.has(mob)).map((mob) => {
            return <button type="button" key={mob} className={props.activeArchetype === mob ? "active" : undefined} onClick={() => props.onChooseMob(mob, "normal")}>{mobDisplayName(mob)}</button>;
          })}</div><section className="dev-dungeon-entrances" aria-label="Developer Dungeon Entrances"><div className="dev-quick-actions"><h3>Dungeon entrances</h3><button type="button" disabled={props.developerDungeonEntrancesLoading} onClick={props.onRequestDungeonEntrances}>Refresh</button>{props.onResetDungeonRun ? <button type="button" className="danger-action" title="Inside a run entered from a developer entrance: every seal, door, flag and the completion go back to the start, and you return to the first room." onClick={props.onResetDungeonRun}>Reset Vault run</button> : null}</div><p className="muted">Choose any active dungeon to place its entrance at one valid world coordinate (developer placement only). Existing dungeon content stays catalog-owned.</p><div className="dev-mob-grid">{developerDungeonEntranceTemplates(DUNGEON_CATALOG).map((template) => <button type="button" key={template.id} onClick={() => props.onChooseDungeonEntrance?.(template.id)}>{template.name}</button>)}</div>{props.developerDungeonEntrancesLoading ? <p role="status">Loading developer dungeon entrances…</p> : null}{!props.developerDungeonEntrancesLoading && (props.developerDungeonEntrances?.length ?? 0) === 0 ? <p className="muted">No active developer dungeon entrances.</p> : null}{props.developerDungeonEntrances?.map((entrance) => <article className="dev-goblin-village-entry" key={entrance.entranceId}><div><strong>{entrance.name}</strong><span>{entrance.lat.toFixed(6)}, {entrance.lon.toFixed(6)}</span><small>{entrance.templateId ?? "Authored template"} · {entrance.createdAt ? new Date(entrance.createdAt).toLocaleString() : "active"}</small></div><button type="button" className="danger-action" disabled={props.developerDungeonEntranceDeleteBusy} onClick={() => props.onDeleteDungeonEntrance?.(entrance)}>Delete</button></article>)}</section><div className="dev-quick-actions"><button type="button" className="danger-action" onClick={props.onClearMobs}>Clear mobs</button><button type="button" onClick={props.onCancelSpawning}>Cancel spawn mode</button></div><section className="dev-goblin-villages" aria-label="Active Goblin Villages"><div className="dev-quick-actions"><h3>Active Goblin Villages</h3><button type="button" disabled={props.goblinVillagesLoading} onClick={props.onRequestGoblinVillages}>Refresh</button></div>{props.goblinVillagesLoading ? <p role="status">Loading Goblin Villages…</p> : null}{!props.goblinVillagesLoading && (props.goblinVillages?.length ?? 0) === 0 ? <p className="muted">No active Goblin Villages.</p> : null}{props.goblinVillages?.map((village) => <article className="dev-goblin-village-entry" key={village.cityId}><div><strong>{village.name}</strong><span>{String(village.hallLat)}, {String(village.hallLon)}</span><small>{village.flagCount} flags · {new Date(village.createdAt).toLocaleString()}</small></div><button type="button" className="danger-action" disabled={props.goblinVillageDeleteBusy} onClick={() => props.onDeleteGoblinVillage?.(village)}>Delete</button></article>)}</section>{props.feedback ? <p role="status" className="dev-feedback">{props.feedback}</p> : null}{props.serverHttpBase ? <DeveloperLegendaryBirdPanel serverHttpBase={props.serverHttpBase} {...(props.csrfToken ? { csrfToken: props.csrfToken } : {})} /> : null}</> : null}
          {tab === "png-lab" && props.pngLabController ? <Suspense fallback={<p role="status">Loading PNG Lab…</p>}><DeveloperPngLab
            controller={props.pngLabController}
            mapZoom={props.mapZoom ?? 14}
            map={props.map ?? null}
            playerPosition={props.playerPosition ?? null}
            onStartPlacement={props.onStartPngPlacement ?? (() => props.pngLabController?.startPlacement())}
            onCenterSelected={props.onCenterPngPlacement ?? (() => undefined)}
          /></Suspense> : null}
          {tab === "mines" ? <div className="dev-permanent-mines">
            <div className="dev-form"><label>Search<input value={mineSearch} placeholder="Mine ID, coordinates, region" onChange={(event) => { setMineSearch(event.currentTarget.value); setMinePage(1); }} /></label><label>State<select value={mineState} onChange={(event) => { setMineState(event.currentTarget.value as typeof mineState); setMinePage(1); }}><option value="all">All</option><option value="ready">Ready</option><option value="depleted">Depleted</option></select></label><button type="button" onClick={() => setMineRefresh((value) => value + 1)}>Refresh</button></div>
            {mineLoading ? <p role="status">Loading permanent mines…</p> : null}
            {mineError ? <p role="alert" className="dev-feedback">{mineError}</p> : null}
            {!mineLoading && !mineError && mines.length === 0 ? <p className="muted">No materialized permanent mines match this view.</p> : null}
            {mines.map((mine) => <article className="dev-mine-entry" key={mine.id}><div><strong>{mine.id}</strong><span>{mine.lat.toFixed(6)}, {mine.lon.toFixed(6)}</span><span>{capitalize(mine.state)}{mine.state === "depleted" ? ` · ${formatRemaining(mine.remainingMs)} remaining` : ""}</span><span>Canonical: {mine.canonicalState} · rev {mine.canonicalRevision ?? "missing"}</span><span>Projection: {mine.projectionState} · state rev {mine.projectionRevision} · harvest rev {mine.harvestRevision}</span>{!mine.canonicalLifecycleValid ? <strong>Impossible canonical lifecycle</strong> : mine.lifecycleMismatch ? <strong>Lifecycle mismatch</strong> : null}<span>{mine.regionCode} · {mine.worldPackageId ?? "unknown package"}</span><small>{mine.placementVersion} · {mine.placementBucketKey}</small><small>{mine.worldEcoregion ?? "Unknown ecoregion"}</small></div><div><span>{mine.coveringFlag ? `${mine.coveringFlag.name} (${Math.round(mine.coveringFlag.distanceM)}m)` : "No active covering flag"}</span>{mine.coveringFlagCount > 1 ? <small>{mine.coveringFlagCount} covering flags</small> : null}{props.worldMutationEnabled ? <button type="button" disabled={!mine.coveringFlag || !props.onVisitMine} onClick={() => props.onVisitMine?.(mine.id)}>Travel to Mine</button> : null}</div></article>)}
            <div className="dev-quick-actions"><button type="button" disabled={minePage <= 1} onClick={() => setMinePage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {minePage} · {mineTotal} mines</span><button type="button" disabled={minePage * 25 >= mineTotal} onClick={() => setMinePage((value) => value + 1)}>Next</button></div>
          </div> : null}
          {tab === "bug-reports" ? <DeveloperBugReportsPanel serverHttpBase={props.serverHttpBase} /> : null}
          {tab === "ui-standards" ? <UiStandardsGallery /> : null}
          {tab === "developer-view" ? <section aria-label="Developer View"><h3>Developer View</h3><p className="muted">All developer displays are independent and off by default.</p>{props.zoomIndicatorAvailable ? <ToolToggle label="Show Zoom Level" description="Show the active map's live MapLibre zoom level." checked={props.zoomIndicatorEnabled} onChange={props.onZoomIndicatorChange} /> : null}<ToolToggle label="Show resource vision" description="Show the resource-radius overlay and compact resource panel." checked={props.resourceVisionEnabled} onChange={props.onResourceVisionChange} /><ToolToggle label="Show combat diagnostics" description="Show combat health, entity, and retained-render counts." checked={props.combatDiagnosticsEnabled} onChange={props.onCombatDiagnosticsChange} />{props.onHurtCirclesChange ? <ToolToggle label="Show hurt circles" description="Draw the ground hurt circle under every combatant (attacks hit when their shape overlaps it)." checked={props.hurtCirclesEnabled === true} onChange={props.onHurtCirclesChange} /> : null}<ToolToggle label="Show movement / networking diagnostics" description="Show movement coordinates and leash, online players, RTT, and snapshot age." checked={props.movementDiagnosticsEnabled} onChange={props.onMovementDiagnosticsChange} /><ToolToggle label="Show geography / resource diagnostics" description="Show world identity, territory, buildability, flags, collectibles, and water state." checked={props.geographyDiagnosticsEnabled} onChange={props.onGeographyDiagnosticsChange} /><ToolToggle label="Show mobile diagnostics" description="Show viewport, startup, connection, and phone HUD diagnostics." checked={props.mobileDiagnosticsEnabled} onChange={props.onMobileDiagnosticsChange} /><ToolToggle label="Show performance panel" description="Show live metrics and bounded recording controls." checked={props.performanceEnabled} onChange={props.onPerformanceChange} /><PerfProbeToggles />{props.onRevealAllClassesChange ? <ToolToggle label="Reveal all classes" description="List every class, including locked full-roster classes, in Skills & Professions. Purchases stay server-authoritative." checked={props.revealAllClassesEnabled === true} onChange={props.onRevealAllClassesChange} /> : null}{props.onLegacyIndoorDungeonChange ? <ToolToggle label="Use legacy indoor dungeon scene" description="Draw dungeons and the Cistern Warrens with the old indoor scene instead of the world map renderer. Session only; takes effect on the current dungeon room." checked={props.legacyIndoorDungeonEnabled === true} onChange={props.onLegacyIndoorDungeonChange} /> : null}</section> : null}
          {tab === "diagnostics" ? <><div className="dev-quick-actions"><button type="button" onClick={props.onOpenConsole}>Open developer console</button><button type="button" disabled={!props.onOpenGameplayLatencyTrace} onClick={props.onOpenGameplayLatencyTrace}>Open Gameplay Latency Trace</button>{props.economyMutationEnabled ? <><button type="button" onClick={props.onOpenProgression}>Open progression controls</button><button type="button" onClick={props.onResetClassAbilityCooldowns}>Reset class ability cooldowns</button><button type="button" disabled={!props.onGrantAllPets} onClick={props.onGrantAllPets}>Grant all pets</button><button type="button" disabled={!props.onResetSkillTreeV3 || props.skillTreeResetBusy} onClick={props.onResetSkillTreeV3}>{props.skillTreeResetBusy ? "Resetting V3 skill tree…" : "Reset V3 skill tree"}</button></> : null}<button type="button" disabled={!props.selectedFlagName || !props.onOpenFlagDiagnostics} onClick={props.onOpenFlagDiagnostics}>{props.selectedFlagName ? `Open flag diagnostics: ${props.selectedFlagName}` : "Select a flag for diagnostics"}</button></div></> : null}
        </div>
        </div>
        </div>
        <footer><button type="button" onClick={props.onDisableViews}>Disable all developer views</button><button type="button" onClick={props.onClose}>Done</button></footer>
      </section>
      <DeveloperEconomyObservatory
        open={economyObservatoryOpen && props.open && props.developerObserveEnabled === true}
        {...(props.serverHttpBase ? { serverHttpBase: props.serverHttpBase } : {})}
        onClose={() => setEconomyObservatoryOpen(false)}
      />
    </div>
  );
}

function CapitalFoundingSection({ state, onPlan, onConfirm, onLeaveChange }: {
  state: DeveloperCapitalFoundingState;
  onPlan?: (() => void) | undefined;
  onConfirm?: (() => void) | undefined;
  onLeaveChange?: ((leave: boolean) => void) | undefined;
}): React.JSX.Element {
  const plan = state.plan;
  const blockedByMembership = Boolean(plan?.leaveRequired && !state.leaveCurrentCity);
  const canConfirm = Boolean(plan && !state.busy && !state.founded && !blockedByMembership);
  return <section className="dev-capital-founding" aria-label="Found Albuquerque">
    <h3>Found Albuquerque</h3>
    <p className="muted">Founds Albuquerque as the main hub city, owned by you as founder and confirmed Mayor: City Center at Civic Plaza, about 50 attackable territory flags, and an active Mayor House, Warehouse and City Market. Plan first; nothing is written until you confirm.</p>
    <ToolToggle label="Leave current city" description="Destroys your City House in your current city under the normal rules before founding." checked={state.leaveCurrentCity} onChange={(value) => onLeaveChange?.(value)} />
    <div className="dev-quick-actions">
      <button type="button" disabled={state.busy} onClick={onPlan}>{state.busy && !plan ? "Planning..." : "Plan (dry run)"}</button>
      <button type="button" className="danger-action" disabled={!canConfirm} onClick={onConfirm}>{state.busy && plan ? "Founding..." : "Confirm and found"}</button>
    </div>
    {plan ? <p role="status" className="dev-feedback"><strong>Annexes {plan.annexedFlags.length} flags from {new Set(plan.annexedFlags.map((flag) => flag.previousOwnerPlayerId)).size} players</strong> · places {plan.placedFlags.length} new flags</p> : null}
    {plan ? <CapitalPlanSummary plan={plan} /> : null}
    {blockedByMembership && plan?.currentCity ? <p role="alert" className="dev-feedback">You are {plan.currentCity.role === "mayor" ? "the Mayor" : "a member"} of {plan.currentCity.cityName}. Turn on "Leave current city", plan again, and confirm.</p> : null}
    {state.founded ? <p role="status" className="dev-feedback">{state.founded.replayed ? `${state.founded.cityName} was already founded by this request.` : `${state.founded.cityName} founded.`}</p> : null}
    {state.error ? <p role="alert" className="dev-feedback">{state.error}</p> : null}
  </section>;
}

function CapitalPlanSummary({ plan }: { plan: DeveloperCapitalFoundingPlan }): React.JSX.Element {
  const skippedByReason = new Map<string, number[]>();
  for (const skipped of plan.skippedFlags) {
    skippedByReason.set(skipped.reason, [...(skippedByReason.get(skipped.reason) ?? []), skipped.slot]);
  }
  return <div className="dev-capital-plan">
    <p><strong>{plan.cityName}</strong> · {plan.municipalityLabel}</p>
    <p>City Center: {plan.hall.lat.toFixed(5)}, {plan.hall.lon.toFixed(5)}{plan.hall.snappedFromAnchorM > 0 ? ` (snapped ${plan.hall.snappedFromAnchorM} m from the anchor)` : " (at the anchor)"}</p>
    <p>Flags placed: {plan.placedFlags.length} of {plan.candidateFlagCount}</p>
    {plan.annexedFlags.length > 0 ? <><p>Annexed flags (previous owner · position):</p><ul className="dev-capital-annexed">{plan.annexedFlags.map((flag) => <li key={flag.flagId}>{flag.previousOwnerUsername ?? flag.previousOwnerPlayerId} · {flag.lat.toFixed(5)}, {flag.lon.toFixed(5)}</li>)}</ul></> : null}
    {plan.excludedFlags.length > 0 ? <><p className="muted">Left untouched inside the footprint: {plan.excludedFlags.length}</p><ul className="dev-capital-excluded">{plan.excludedFlags.map((flag) => <li key={flag.flagId}>{flag.ownerUsername ?? flag.ownerPlayerId} · {flag.lat.toFixed(5)}, {flag.lon.toFixed(5)} · {flag.reason.replaceAll("_", " ")}</li>)}</ul></> : null}
    {[...skippedByReason].map(([reason, slots]) => <p key={reason} className="muted">Skipped {slots.length} ({reason.replaceAll("_", " ")}): slots {slots.join(", ")}</p>)}
    <p>Structures: {plan.structures.map((structure) => structure.type.replace("_", " ")).join(", ")}</p>
    {plan.leave ? <div className="dev-capital-leave">
      <p><strong>Leaving {plan.leave.cityName} destroys:</strong></p>
      <ul>
        <li>Your {plan.leave.houseType === "mayor_house" ? "Mayor House" : "City House"} and your membership there</li>
        {plan.leave.mayorRelinquished ? <li>Your Mayor role in {plan.leave.cityName}</li> : null}
        {plan.leave.destroyedStructures.map((structure) => <li key={structure.structureId}>Your {structure.type.replace("_", " ")} ({structure.state})</li>)}
        {plan.leave.refundedLines.length > 0 ? <li>Refunded to your inventory: {plan.leave.refundedLines.map((line) => `${line.quantity} ${line.itemId}`).join(", ")}</li> : null}
        {plan.leave.droppedLines.length > 0 ? <li>Dropped on the ground (inventory full): {plan.leave.droppedLines.map((line) => `${line.quantity} ${line.itemId}`).join(", ")}</li> : null}
      </ul>
      <p className="muted">{plan.leave.cityName} itself, its flags, Warehouse, Market and treasury stay.</p>
    </div> : null}
  </div>;
}

function PerfProbeToggles(): React.JSX.Element {
  const [probeOn, setProbeOn] = useState(() => isPerfProbeVisible() || isPerfProbeEnabled());
  const [legacyOn, setLegacyOn] = useState(() => isLegacyRenderQualityEnabled());
  const [lowOn, setLowOn] = useState(() => isReducedRenderQualityEnabled());
  const [standaloneCamera, setStandaloneCamera] = useState(() => cameraDriverMode() === "standalone");
  const [rawCamera, setRawCamera] = useState(() => cameraFilterMode() === "off");
  const [rasterMode, setRasterMode] = useState<RasterAlignmentMode>(() => rasterAlignmentMode());
  const [staticRebuild, setStaticRebuild] = useState(() => staticFollowMode() === "off");
  const [snapCamera, setSnapCamera] = useState(() => cameraSnapMode() === "device");
  const [hideOverlayWalk, setHideOverlayWalk] = useState(() => overlayWalkMode() === "hidden");
  const chooseRaster = (next: RasterAlignmentMode): void => { setRasterMode(next); setRasterAlignmentMode(next); };
  return <>
    <ToolToggle label="Perf probe" description="Small live readout in the corner: fps, frame p95/p99, draw calls, textures, objects, mobs, WS rate, resolution. Same as ?perf=1." checked={probeOn} onChange={(value) => { setProbeOn(value); setPerfProbeEnabled(value); }} />
    <ToolToggle label="Low graphics quality" description="Caps the map and overlay at 2x pixel density and drops overlay antialiasing on phones. Off (High) by default; also set by the low-FPS governor on non-Apple devices. Restart the app after changing it." checked={lowOn} onChange={(value) => { setLowOn(value); setReducedRenderQualityEnabled(value); }} />
    <ToolToggle label="Standalone camera loop" description="A/B switch for map shake: the follow camera runs on its own frame loop and MapLibre renders on its own frame (before t1535), instead of inside the overlay frame. Applies at once." checked={standaloneCamera} onChange={(value) => { setStandaloneCamera(value); setCameraDriverMode(value ? "standalone" : "overlay"); }} />
    <ToolToggle label="Unfiltered camera target" description="A/B switch for map shake: the camera follows the raw predicted player point (corrections and all) instead of the low-pass filtered target. Applies at once." checked={rawCamera} onChange={(value) => { setRawCamera(value); setCameraFilterMode(value ? "off" : "on"); }} />
    <ToolToggle label="Raster alignment: stock MapLibre" description="A/B switch for map stutter: the map snaps raster tiles to whole pixels while the camera follows (the old behaviour). Off (smooth, auto) by default. Applies at once." checked={rasterMode === "on"} onChange={(value) => chooseRaster(value ? "on" : "auto")} />
    <ToolToggle label="Raster alignment: never" description="A/B switch for map stutter: raster tiles are never pixel-aligned, even at rest. Applies at once." checked={rasterMode === "off"} onChange={(value) => chooseRaster(value ? "off" : "auto")} />
    <ToolToggle label="Rebuild overlay every follow frame" description="A/B switch for map stutter: the old behaviour, static overlay layers (trees, flags, items) are rebuilt on every follow frame instead of moved and refreshed about 4 times a second. Applies at once." checked={staticRebuild} onChange={(value) => { setStaticRebuild(value); setStaticFollowMode(value ? "off" : "freeze"); }} />
    <ToolToggle label="Snap camera to device pixels" description="A/B switch for map stutter: the follow pan is rounded to whole screen pixels with the remainder carried. Applies at once." checked={snapCamera} onChange={(value) => { setSnapCamera(value); setCameraSnapMode(value ? "device" : "off"); }} />
    <ToolToggle label="Hide overlay while walking" description="Diagnostic only: the sprite overlay draws nothing and is hidden while the camera follows, so only the map shows. Applies at once." checked={hideOverlayWalk} onChange={(value) => { setHideOverlayWalk(value); setOverlayWalkMode(value ? "hidden" : "off"); }} />
    <ToolToggle label="Legacy render pacing" description="A/B switch: the overlay renders every frame instead of skipping idle frames. Off by default; restart the app after changing it." checked={legacyOn} onChange={(value) => { setLegacyOn(value); setLegacyRenderQualityEnabled(value); }} />
  </>;
}
function ToolToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <label className="developer-tool-toggle"><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /></label>;
}

function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
export function DeveloperPresentationControl({ value, onChange }: { value: PresentationPreview; onChange(value: PresentationPreview): void }): React.JSX.Element {
  return <section aria-label="Developer presentation preview">
    <div className="dev-form"><label>Presentation preview<select aria-describedby="presentation-preview-help" value={value} onChange={(event) => onChange(event.currentTarget.value as PresentationPreview)}>
      <option value="auto">Auto — detect this device</option>
      <option value="desktop">Desktop — command HUD &amp; floating chat</option>
      <option value="touch">Mobile — touch HUD &amp; full-screen apps</option>
    </select></label></div>
    <p id="presentation-preview-help" className="muted">Developer-only preview. Switches HUD, menus and chat immediately; resize the window to inspect phone widths. Auto restores device detection. Reload or sign out resets to Auto.</p>
  </section>;
}
function mobDisplayName(value: MobArchetypeKey): string {
  return value.split("_").map(capitalize).join(" ");
}
function developmentItemName(value: InventoryItemType): string {
  return GRANTABLE_RESOURCE_CATALOG.find((item) => item.itemId === value)
    ?.displayName ?? capitalize(value);
}
function formatRemaining(milliseconds: number): string { const minutes = Math.max(0, Math.ceil(milliseconds / 60_000)); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
