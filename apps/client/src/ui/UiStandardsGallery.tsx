import { InventoryCarrySummary, InventoryEntryRow, ProtectShieldGlyph } from "./InventoryCarryList.js";
import { PartyRosterSummary } from "./MobilePartyApp.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { KitchenRecipeTabs } from "./KitchenPrompt.js";
import type { KitchenRecipeCategory } from "@ash-atlas/shared";
import { lazy, Suspense, useState } from "react";
import { CurrencyGlyph } from "./InventoryCarryList.js";
import { QuantityStepper } from "./ShopApp.js";
import { RUNTIME_PNG_PRESENTATION_CATALOG, TERRITORY_STRUCTURE_CATALOG, TERRITORY_STRUCTURE_TYPES, WORLD_OBJECT_ZOOM_POLICY, emptyInventoryTotals } from "@ash-atlas/shared";
import type { SkillSystemV3Snapshot } from "@ash-atlas/shared";
import { useUiPresentation } from "../uiEnvironment.js";

const GatheringAnimationPreview = lazy(async () => ({
  default: (await import("./GatheringAnimationPreview.js")).GatheringAnimationPreview
}));
const MilitaryAnimationPreview = lazy(async () => ({
  default: (await import("./MilitaryAnimationPreview.js")).MilitaryAnimationPreview
}));

import { GameActionPrompt, GameConfirmationPrompt, GamePromptButton } from "./GameActionPrompt.js";
import { PlayerTapMenu } from "./PlayerTapMenu.js";
import type { PublicProfile } from "@ash-atlas/shared";
import { DesktopWindow } from "./DesktopWindow.js";
import {
  GameAppActionBar,
  GameAppBackButton,
  GameAppBody,
  GameAppButton,
  GameAppCard,
  GameAppCloseButton,
  GameAppDivider,
  GameAppEmptyState,
  GameAppFooter,
  GameAppHeader,
  GameAppIconButton,
  GameAppScrollRegion,
  GameAppSectionHeader,
  GameAppState,
  GameAppTabs,
  GameAppText
} from "./GameAppShell.js";
import { GameTargetPicker } from "./GameTargetPicker.js";
import { GameMessageBox } from "./GameMessageBox.js";
import { SkillLedger } from "./SkillTreeV3Panel.js";
import { RankLadder } from "./RankLadder.js";
import { LegendJournalView } from "./LegendJournalContent.js";
import { PhoneMenuBackGlyph, PhoneMenuFooterButtons } from "./PhoneMenuDestinationShell.js";
import { MOBILE_MENU_DESTINATIONS } from "../mobileGameMenu.js";
import {
  GameMenuDirectory,
  DesktopCommandMenu,
  GameMenuWorldTime,
  GameMenuProfileSummary,
  MenuDestinationGlyph,
  type GameMenuProfileSummaryData,
  type PhoneMenuDestination
} from "./PhoneHud.js";
import { PlannedUpdateStatus } from "./PlannedUpdateStatus.js";
import { ClientUpdateHelpScreen } from "./ClientUpdateStatus.js";
import { ConnectionRecoveryScreen, UpdateBanner } from "./ConnectionRecoveryScreen.js";
import { SkillSystemV3CombatControls } from "./SkillSystemV3CombatControls.js";
import { WorldActivityTimerPlate } from "./WorldActivityTimerPlate.js";
import { FieldBuffStrip } from "./FieldBuffStrip.js";
import { WorldZoneBanner, WorldZoneReadout } from "./WorldZoneBanner.js";
import { RegionCelebration } from "./RegionCelebration.js";
import { achievementCard, celebrationCardsFor } from "./celebrationQueue.js";
import { WorldMapLayerControl } from "./WorldMapLayerControl.js";
import { createDefaultWorldEnvironmentOverlaySelections } from "../map/worldEnvironmentOverlays.js";
import { WORLD_PNG_PRESENTATION } from "../map/worldPngPresentation.js";
import { HudNoticeStack, type HudNotice } from "./HudNoticeLane.js";
import { LootFeedRows } from "./CombatRewardHud.js";
import type { LootFeedRow } from "../combat/lootFeed.js";

const HUD_LANE_SAMPLE_NOTICES: readonly HudNotice[] = [
  { id: 1, text: "Bone Guard defeated — Crypt Gatehouse is open.", tone: "success", count: 1, expiresAt: Number.MAX_SAFE_INTEGER },
  { id: 2, text: "Crypt Chest appeared.", tone: "info", count: 1, expiresAt: Number.MAX_SAFE_INTEGER },
  { id: 3, text: "Dungeon complete.", tone: "success", count: 1, expiresAt: Number.MAX_SAFE_INTEGER }
];
const hudLaneRow = (key: string, kind: LootFeedRow["kind"], text: string, icon: string | null = null): LootFeedRow =>
  ({ key, kind, text, icon, amount: 1, createdAtMs: 0, lastAtMs: 0, expiresAtMs: Number.MAX_SAFE_INTEGER });
const HUD_LANE_SAMPLE_ROWS: readonly LootFeedRow[] = [
  hudLaneRow("sample-item", "item", "Iron Shield ×1", "iron_shield"),
  hudLaneRow("sample-gold", "gold", "+14 Gold"),
  hudLaneRow("sample-xp", "xp", "+20 Hunter XP")
];

type CompactSample = "single" | "phone-sheet" | "multi" | "military" | "access" | "disabled" | "player" | "busy" | "error" | "confirm" | "forced" | "targets" | "travel";

const compactSamples: readonly Readonly<{ id: CompactSample; label: string }>[] = [
  { id: "single", label: "Single action" },
  { id: "phone-sheet", label: "Phone world sheet" },
  { id: "multi", label: "Primary + quick action" },
  { id: "military", label: "Military merge row" },
  { id: "access", label: "Two-option access" },
  { id: "disabled", label: "Unavailable action (hidden)" },
  { id: "player", label: "Player tap menu" },
  { id: "busy", label: "Busy" },
  { id: "error", label: "Unavailable" },
  { id: "confirm", label: "Confirmation" },
  { id: "forced", label: "Forced state" },
  { id: "targets", label: "Target picker" },
  { id: "travel", label: "Travel cost" }
];

const worldPngZoomSamples = [
  { label: "Tannery", presentation: WORLD_PNG_PRESENTATION.tannery },
  { label: "Loom", presentation: WORLD_PNG_PRESENTATION.loom },
  { label: "Cistern Warrens", presentation: WORLD_PNG_PRESENTATION.cityStructures.cistern_warrens }
] as const;

const skillControlsSample: SkillSystemV3Snapshot = {
  playerId: "ui-standards-gallery",
  characterLevel: 25,
  pointState: { totalEarned: 25, totalSpent: 9, available: 16, revision: 4 },
  generalSkills: [
    { skillId: "cleave", rank: 3, pointsSpent: 3 },
    { skillId: "shield_charge", rank: 2, pointsSpent: 2 },
    { skillId: "cleanse", rank: 1, pointsSpent: 1 }
  ],
  specializations: [{ specializationId: "warrior", rank: 3, pointsSpent: 6, grandfathered: false, masteryQuestCompleted: false }],
  committedSpecializationId: "warrior",
  activeSpecializationId: "warrior",
  equippedClassTechniqueId: null,
  fullBuildRespecAvailable: false,
  fullClassRosterEnabled: false,
  ultimatesEnabled: false,
  generalActiveLoadout: ["shield_charge", "cleanse"],
  ultimate: null,
  cooldownEndsAt: {},
  worldKnowledge: [],
  serverTime: 1_800_000_000_000,
  revision: 4
};

export function UiStandardsGallery(): React.JSX.Element {
  const [inventoryCategory, setInventoryCategory] = useState("all");
  const [kitchenCategory, setKitchenCategory] = useState<KitchenRecipeCategory>("raw");
  const [compactSample, setCompactSample] = useState<CompactSample>("single");
  const [appTab, setAppTab] = useState("overview");
  const [gatheringPreviewOpen, setGatheringPreviewOpen] = useState(false);
  const [militaryPreviewOpen, setMilitaryPreviewOpen] = useState(false);
  const [longAppTab, setLongAppTab] = useState("overview");
  const [appSubtab, setAppSubtab] = useState("resources");
  const [desktopWindowDemoOpen, setDesktopWindowDemoOpen] = useState(false);
  const presentation = useUiPresentation();
  const ignore = (): void => {};
  const menuDestinations: readonly PhoneMenuDestination[] = MOBILE_MENU_DESTINATIONS.map(({ id }) => ({ id }));
  const menuProfile: GameMenuProfileSummaryData = {
    player: { username: "Wren", displayColor: null },
    titleLabel: "Wayfarer",
    kingdomLabel: "Emberreach",
    cityLabel: "Ashford",
    className: "Ranger",
    levelLabel: "Level 14",
    kdLabel: "—",
    goldLabel: "2,481",
    healthLabel: "95 / 100",
    hungerLabel: "2,000 / 2,000",
    hungerPercent: 100,
    hungerState: "full",
    xpLabel: "72%",
    xpPercent: 72,
    packLabel: "72.4 / 100 kg"
  };

  const [shopQuantity, setShopQuantity] = useState(1);
  return <section className="ui-standards-gallery" aria-label="UI Standards Gallery">
    <GameAppText>Creator tools preserve active workspace and task names across detail levels. Canvas arrows belong to the focused canvas; hidden editors never receive shortcuts. Rarity artwork cards reflow to their container width. Validation opens the affected resource or chest field and clears after recovery; local simulation is labelled separately from a saved game test. Dungeon templates duplicate into independent loot tables without copying a live world placement; display names are editable while internal identities remain stable.</GameAppText>
    <header>
      <span className="eyebrow">Live canonical components</span>
      <h3>UI Standards Gallery</h3>
      <p className="muted">Existing health, presence, success, readiness, progress, protection, beneficial-effect and class/item-status indicators retain their current colors as explicit palette exceptions. Panels, navigation, focus and selection keep the medieval palette. New color treatments require a design update.</p>
      <p className="muted">Responsive examples use the same components available to player-facing features.</p>
      <p className="muted">Manor floor and room doors use the same PORTAL prompt and locked-action state below. Their authored click polygons select a door; only the universal location transition moves the player. Studio previews show the same door choices without granting runtime access.</p>
    </header>

    <section className="ui-standards-section" aria-labelledby="menu-appearance-standard-title">
      <h4 id="menu-appearance-standard-title">Light parchment · Dark walnut</h4>
      <p className="muted">F1 → Developer View → Presentation preview switches Auto / Desktop / Mobile immediately through the shared environment. It is developer-only and resets to Auto on reload or sign out; resize the window to inspect phone widths. Desktop windows keep header and footer inside even a short stage, with internal content scrolling.</p>
      <p className="muted">Desktop command row (fine-pointer, non-touch windows at least 1100 × 600): the same destinations become direct commands. Tablets retain the compact touch HUD and full-screen apps; desktop chat, app shells, and ordinary movable compact prompts use the shared floating window frame.</p>
      <DesktopCommandMenu destinations={MOBILE_MENU_DESTINATIONS.map(({ id }) => ({ id }))} onOpenDestination={ignore} />
      <p className="muted">Settings &amp; Support → Gameplay → Appearance applies the shared theme immediately and saves it per player on this device. Light parchment is the default. The gallery uses the same live tokens and canonical components as every app, compact prompt, tab rail, list, field, footer, and HUD control. World artwork and semantic status colors retain their own presentation.</p>
      <GameAppCard title="Layered parchment" description="Warm readable text, a quiet brass rule, and one consistent control surface."
        action={<GameAppActionBar><GameAppButton variant="primary" onClick={ignore}>Primary action</GameAppButton><GameAppButton variant="quiet" onClick={ignore}>Secondary action</GameAppButton></GameAppActionBar>}>{null}</GameAppCard>
      <p className="muted">DesktopWindow shares one viewport layer so dock popups stay above open apps. The top-centre chat plaque stays visible and usable while apps are open, and windows are clamped below it. It uses the full unused title-bar area for movement and keeps its subtle functional ⠿ glyph. A window opened from the dock is top-level: its one footer action is a centred text Close (no Back, no Return to Game); Back shows only for in-app sub-pages and returns to the parent page. Footer buttons use the Game Menu card styling (text-only Return always centred, chevron plus Back at the left) in a band as tall as the window header, and close controls are text, never an X glyph. A window with its own action row keeps it at the left with Close at the right of the same band, scene-opened windows (Manor, Salon) are top-level, and desktop copy says click, right-click and double-click rather than tap or hold. Four invisible corner hit areas provide resize affordances with matching diagonal cursors and focus-visible outlines; decorative rivets and visible bottom-right resize artwork are not part of the contract. Arrow keys move the selected title-bar or corner control in 10px steps, or 40px with Shift; resizing keeps the opposite corner fixed under the minimum, viewport, and HUD clamps. Normal windows clamp to 420 × 360, compact prompts to 260 × 140 with a 352px natural-height default, and bounds survive close/reopen and reload: a move or resize is saved per character, window, and desktop presentation on this device, then clamped to the current viewport on restore. Default placement: Atlas Chats, Messages and Construction dock on the right (16px from the edge, below the top chat plaque; Construction keeps its title, plan count and section tabs pinned while the plans scroll); every other app opens on the left (16px edge, below the unit frame), sized to the viewport without covering the fixed HUD corners. Settings & Support › Gameplay › Appearance has a desktop-only Reset window positions action that clears saved rects and snaps open windows back to these defaults. Every script-focused window and prompt container never shows a focus outline; buttons and title/resize handles keep the focus-visible ring. Desktop has no Menu-hold gesture, so its settings and tips never mention holding Menu or the bag. Touch/tablet presentation remains full-screen and handle-free.</p>
      <GameAppButton type="button" disabled={presentation !== "desktop"} onClick={() => setDesktopWindowDemoOpen(true)}>
        {presentation === "desktop" ? "Open DesktopWindow demo" : "DesktopWindow demo · use Desktop preview"}
      </GameAppButton>
      {desktopWindowDemoOpen && presentation === "desktop" ? <DesktopWindow
        windowKey="ui-standards:desktop-window-demo"
        aria-label="DesktopWindow demo"
        onRequestClose={() => setDesktopWindowDemoOpen(false)}
      >
        <GameAppHeader
          eyebrow="Live component"
          title="Windowed field log"
          subtitle="Header, body, and footer stay in one bounded frame"
          closeLabel="Close DesktopWindow demo"
          onClose={() => setDesktopWindowDemoOpen(false)}
        />
        <GameAppBody>
          <GameAppText tone="body">Drag the unused title-bar space, resize from any invisible corner hit area, or focus the title-bar/corner control and use Arrow keys. Shift moves or resizes by 40px instead of 10px.</GameAppText>
        </GameAppBody>
        <GameAppFooter>
          <GameAppActionBar>
            <GameAppButton type="button" onClick={() => setDesktopWindowDemoOpen(false)}>Close demo</GameAppButton>
          </GameAppActionBar>
        </GameAppFooter>
      </DesktopWindow> : null}
    </section>
    <section className="ui-standards-section" aria-labelledby="inventory-carry-standard-title">
      <h4 id="inventory-carry-standard-title">Inventory · quantities and carrying capacity</h4>
      <p className="muted">Inventory and Party share the active parchment surface: cream/tan with brown text by default, or dark walnut with ivory text. Favorite stars occupy a dedicated 44px column at the far right. Narrow item rows put quantity and weight below the name; the padded capacity summary wraps values without clipping.</p>
      <p className="muted">The summary card stacks the Carry weight row directly over its capacity bar, then one row of three equal currency chips (gold coin Gold, spark Glimmer, gem Lumen); a long value wraps to two lines inside its chip and never clips, truncates, or scrolls. Protect (shield plus label) is a compact 44px header action at the top right; the header has no carried-kg chip. Glimmer and Lumen stay off the dock and HUD.</p>
      <div className="inventory-header-actions">
        <GameAppButton type="button" className="inventory-header-action" aria-label="Item Protection" onClick={ignore}><ProtectShieldGlyph />Protect</GameAppButton>
      </div>
      <p className="muted">Inventory contains items only. Equipment opens the canonical compact action prompt for Equip, Upgrade with a gold confirmation, and Drop. Favorites use an explicit star toggle, sort first, and persist per player on this device. Item Protection is a bounded shell: its visible, focusable tabs stay with the header while one contained active-tab scroller owns rows and the footer remains fixed. The carry summary and category subtabs remain visible while item rows scroll. Inventory rows use one mobile-equivalent 34px item-art frame and the same row geometry on phone and desktop, so the shared authored PNG scale stays comparable across profiles. On phones, the canonical subtabs rail scrolls horizontally with 44px touch cells so every category remains readable; Backpack count badges are intentionally omitted. The Glimmer chip gains a 44px Get Glimmer action only while a purchase path is enabled; it opens the Get Glimmer app (standard rows with the store's localized price, Restore purchases, Terms link) and Atlas Pass app, which render nothing while every purchase flag is off. Each balance keeps its quantity; unique equipment and every Backpack +N instance keep their identity. The equivalent Backpacks group is uncapped: identical entries may display as ×N while existing item actions retain each instance identity. Catalog-derived Resources, Consumables, Equipment, and Backpacks categories avoid the ambiguous Supplies label. Backpacks are crafted as +0 for 80 Leather and 2,000 Gold, weigh 0 kg, and every owned instance adds +5 through +55 kg capacity. The quantity picker (Add to Gift, Drop, Store, Split) is a parchment control: a themed slider, an inline readable number field on the paper tone with dark text, and 42px minus and plus steppers, never a dark field on the parchment.</p>

      <InventoryCarrySummary inventory={{ playerId: "gallery", revision: 1, items: [], totals: emptyInventoryTotals(), currentWeightGrams: "72400", maximumWeightGrams: "1000000" }}
        gold="12,450" premiumBalances={{ glimmer: { balance: "1500", revision: "1" }, lumen: { balance: "300", revision: "1" } }} />
      <GameAppTabs variant="subtabs" scrollable activeTab={inventoryCategory} ariaLabel="Inventory category example" onChange={setInventoryCategory}
        tabs={[{ id: "all", label: "All" }, { id: "equipment", label: "Equipment" }, { id: "resources", label: "Resources" }, { id: "consumables", label: "Consumables" }, { id: "backpacks", label: "Backpacks" }]} />
      <ul className="inventory-carry-list">
        {inventoryCategory === "all" || inventoryCategory === "resources" ? <InventoryEntryRow name="Wood" quantity={437} weightGrams="43700" favorite onToggleFavorite={ignore} artwork={<ItemArtwork itemId="wood" label="Wood" />} onSelect={ignore} /> : null}
        {inventoryCategory === "all" || inventoryCategory === "equipment" ? <InventoryEntryRow name="Starter Sword" quantity={1} weightGrams="1500" detail="Level 3 · Equipped" artwork={<ItemArtwork itemId="starter_sword" label="Starter Sword" />} onSelect={ignore} /> : null}
        {inventoryCategory === "all" || inventoryCategory === "consumables" ? <InventoryEntryRow name="Giving Berry" quantity={4} weightGrams="100" detail="Healing · up to 24 HP" artwork={<ItemArtwork itemId="giving_berry" label="Giving Berry" />} onSelect={ignore} /> : null}
        {inventoryCategory === "all" || inventoryCategory === "consumables" ? <InventoryEntryRow name="Simple Food" quantity={12} weightGrams="3000" artwork={<ItemArtwork itemId="simple_food" label="Simple Food" />} onSelect={ignore} /> : null}
        {inventoryCategory === "all" || inventoryCategory === "backpacks" ? <InventoryEntryRow name="Backpack +2" quantity={1} weightGrams="0" detail="+15 kg capacity · Owned" artwork={<ItemArtwork itemId="pack" label="Backpack +2" />} onSelect={ignore} /> : null}
      </ul>
    </section>
    <section className="ui-standards-section" aria-labelledby="party-roster-standard-title">
      <h4 id="party-roster-standard-title">Party · compact roster</h4>
      <p className="muted">Only actual members receive roster rows. Remaining capacity is summarized once. Invitations and canonical actions sit beside the roster on desktop and stack below it on phone; Messages owns incoming request responses.</p>
      <div className="phone-party-roster"><PartyRosterSummary memberCount={0} hasParty={false} /></div>
    </section>
    <section className="ui-standards-section" aria-labelledby="compact-standards-title">
      <div>
        <h4 id="compact-standards-title">Compact interaction UI</h4>
        <label>Example
          <select value={compactSample} onChange={(event) => setCompactSample(event.currentTarget.value as CompactSample)}>
            {compactSamples.map((sample) => <option key={sample.id} value={sample.id}>{sample.label}</option>)}
          </select>
        </label>
      </div>
      <div className="ui-standards-compact-preview">
        {compactSample === "single" ? <GameActionPrompt movable={false} title="Manor Door" category="PORTAL" actions={[{ key: "leave", label: "Leave Manor", onSelect: ignore }]} onCancel={ignore} /> : null}
        {compactSample === "phone-sheet" ? <GameActionPrompt compact movable={false} title="Giving Tree (Fruiting)" actions={[{ key: "chop", label: "Chop", onSelect: ignore }, { key: "berries", label: "Gather Berries", onSelect: ignore }]} onCancel={ignore} /> : null}
        {compactSample === "multi" ? <GameActionPrompt
          movable={false}
          title="Dire Wolf"
          category="COMBAT TARGET"
          actionLayout="primary-quick"
          actions={[
            { key: "attack", label: "Attack", onSelect: ignore },
            { key: "shield-charge", label: "Shield Charge", tone: "secondary", onSelect: ignore }
          ]}
          onCancel={ignore}
        /> : null}
        {compactSample === "military" ? <GameActionPrompt
          movable={false}
          title="Kippen Siege +4 · 600/600 HP"
          category={null}
          detail={null}
          actionLayout="military-main-merge"
          actions={[
            { key: "move-to-me", label: "Move to Me", onSelect: ignore },
            { key: "follow", label: "Follow", onSelect: ignore },
            { key: "pack-up", label: "Pack Up", onSelect: ignore },
            { key: "merge", label: "Merge", enabled: false, disabledReason: "No compatible owned Siege group is within 1000 meters.", onSelect: ignore }
          ]}
          onCancel={ignore}
        /> : null}
        {compactSample === "access" ? <GameActionPrompt
          movable={false}
          title="Ash's Flag"
          category="FLAG OPTIONS"
          content={<fieldset className="flag-more-access">
            <legend>Access</legend>
            <div className="flag-more-access-options">
              <GamePromptButton onClick={ignore}>Public</GamePromptButton>
              <GamePromptButton onClick={ignore}>Private</GamePromptButton>
            </div>
          </fieldset>}
          actions={[]}
          onCancel={ignore}
        /> : null}
        {compactSample === "disabled" ? <GameActionPrompt
          movable={false}
          title="Locked Door"
          category="PORTAL"
          actions={[{ key: "enter", label: "Enter", enabled: false, onSelect: ignore }, { key: "knock", label: "Knock", onSelect: ignore }]}
          onCancel={ignore}
        /> : null}
        {compactSample === "player" ? <PlayerTapMenu
          relation="enemy"
          pvpStatusLabel="Your aggressor · 18h"
          profile={{ playerId: "sample-player", displayName: "Ash Walker", level: 12, class: { id: "warrior", name: "Warrior" }, kingdom: null, settlement: null, isSelf: false, presence: "online", relationship: { friendship: "none", enemyMarkedByViewer: true } } as unknown as PublicProfile}
          skillActions={[{ key: "stride", label: "Edict Stride", onSelect: ignore }, { key: "bite", label: "Bite 4s", enabled: false, cooling: true, onSelect: ignore }]}
          onAttack={ignore} onViewProfile={ignore} onClose={ignore}
        /> : null}
        {compactSample === "busy" ? <GameActionPrompt
          movable={false}
          title="Smithing Station"
          category="CRAFTING"
          actions={[{ key: "smith", label: "Approaching…", busy: true, disabledReason: "Walking to the Smithing Station.", onSelect: ignore }]}
          onCancel={ignore}
        /> : null}
        {compactSample === "error" ? <GameActionPrompt
          movable={false}
          title="Manor Floor Drop"
          category="MANOR"
          message={{ text: "Floor drops are unavailable while disconnected.", tone: "error" }}
          actions={[{ key: "drop", label: "Drop Item", enabled: false, onSelect: ignore }]}
          onCancel={ignore}
        /> : null}
        {compactSample === "confirm" ? <GameConfirmationPrompt title="Remove this guest?" confirmLabel="Remove Guest" cancelLabel="Keep Guest" destructive onConfirm={() => setCompactSample("single")} onCancel={() => setCompactSample("single")} /> : null}
        {compactSample === "forced" ? <GameActionPrompt
          movable={false}
          forced
          title="YOU FELL"
          detail="Lost 3% EXP (25,000 EXP)"
          actions={[{ key: "respawn", label: "Respawn", onSelect: () => setCompactSample("single") }]}
          onCancel={ignore}
        /> : null}
        {compactSample === "travel" ? <GameActionPrompt
          movable={false}
          title="Ash Realm"
          category="WORLD MAP"
          detail="Travel cost: 25 Hunger"
          actions={[{ key: "travel", label: "Travel", onSelect: ignore }]}
          onCancel={ignore}
        /> : null}
        {compactSample === "targets" ? <GameTargetPicker
          ariaLabel="Choose a gallery target"
          choices={[
            { key: "wolf-near", name: "Wolf", category: "Creature", meta: "18m 45%", detail: "Level 4", quickAction: { label: "Attack", enabled: true } },
            { key: "flag", name: "Ash's Flag", category: "Territory flag", meta: "26m", detail: "Public · Free", quickAction: { label: "Travel", enabled: true } },
            { key: "fruiting-tree", name: "Giving Tree (Fruiting)", category: "Resource", meta: "30m", quickAction: { label: "Gather", enabled: true } },
            { key: "plain-tree", name: "Giving Tree", category: "Resource", meta: "31m", quickAction: { label: "Chop", enabled: true } },
            { key: "stone", name: "Stone Mine", category: "Resource", meta: "31m", detail: "Stone", quickAction: { label: "Gather", enabled: true } },
            { key: "drop", name: "Leather", category: "Dropped item", meta: "42m", quickAction: { label: "Take All", enabled: true } }
          ]}
          onSelect={ignore}
          onQuickAction={ignore}
          onCancel={ignore}
        /> : null}
        {compactSample === "phone-sheet" ? <p className="muted">
          Phone taps on trees, mines, creatures, flags, and dropped items use this compact sheet: it uses the standard gilded parchment prompt leaf (brass double rule, plaque actions) and width, pairs actions as split bars, uses a one-line title, and ends with the quiet Cancel row. Tapping outside or Escape also cancels.
        </p> : null}
        {compactSample === "targets" ? <p className="muted">
          Rows may show one concise detail from the target snapshot, such as level, access, ownership, or resource type. World relocation uses Travel. Each row is one rounded pill split into even halves: name over distance · detail, then the quick action. All simple picker quick actions occupy the right half of their row, including Attack, Chop, Gather, and Take. Siege deployment retains its separate controls. Fruiting Giving Trees use Gather; their detail area opens the full prompt, including Chop. Plain trees use Chop, other resources and mines use Gather, and dropped items use Take. The row the player is acting on (the mob being fought, the node being gathered) shows a small gold dot before its name, and its gather quick action reads in progress, such as Chopping. While Choose Target is open, the active world target uses one compact gold anchor chevron with a fixed screen-size visible footprint at 75% opacity and no additional selection circle. Repeated targets with the same presented identity start nearest-first without moving other identities; tree varieties and item variants remain distinct. Hover or focus replaces the active preview; pointer or focus exit leaves the last preview active. It disappears immediately on selection, action, Cancel, outside release, or any other picker close. Each pointer or touch press belongs to its original control: a click or tap without meaningful movement activates that control, while movement beyond the small threshold, release over another control, or pointer cancel activates nothing and keeps the picker open. Releasing outside cancels the picker. When a bulk action such as Take All is present, the item rows are the only vertical scroll owner and Take All / Cancel stay pinned in the footer; phone geometry reserves three visible item rows plus those two footer rows (five canonical row-heights total); further rows scroll by touch with no visible scrollbar (no game UI ever shows a native scrollbar; compact prompts size to their content; re-tapping a target whose action is running shows the action in progress, such as Chopping, with Cancel enabled to stop it). On phone, Tap assistance offers Precise (6px), Standard (12px), and Large (20px) assisted candidate padding; Standard is the default. Larger assistance makes small world objects easier to tap, but may show Choose Target more often in crowded areas. Base hitboxes and target ordering do not change. Map gesture ownership follows explicit intent: a normal single click or tap confirms after the Double-tap window (100ms default, 50-200ms in Settings &gt; Map), a second primary click before that or within the 300ms recognition window after it remains the double-click movement gesture, and native map panning begins immediately after its small movement threshold instead of waiting for click recognition; drawing, placement, teleport, developer-spawn, or selected planner-build actions consume only their concrete route without exempting ordinary world entities or every empty ruler-map click.
        </p> : null}
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="connection-status-standards-title">
      <div>
        <h4 id="connection-status-standards-title">Updates and startup recovery</h4>
        <p className="muted">An outdated client never starts: at launch the update applies before play. When a new build is published while playing, the Update ready banner appears under the chat bar with a 15-second countdown ring and Update now; native apps download the bundle in the background first and keep checking until it is available. When the countdown ends or the player taps Update now, the boot screen reads Updating… and the web client reloads the new build or the native app applies its bundle. When the server has already refused the build, the update applies at once with no countdown. At native app launch, before play, the check must succeed: an update that fails, is blocked, needs a newer app, or cannot reach the server keeps a boot-screen error with a Try Again button and never opens the installed old bundle. If an update fails, the same error screen offers Try Again; a native update that is not downloadable yet is also retried automatically. The client checks for a new release every 10 seconds. The server admits only the published client build for each platform, after a 90-second grace from when it first sees a new build: an outdated client reconnecting after the deploy restart is admitted during the grace so its countdown can finish, and afterwards a new connection from another build is refused and a connected outdated client, even an idle one, is closed. Boot, update and recovery screens follow the device light or dark setting: dark is warm near-black, light uses the parchment palette from the menu appearance tokens, and the static first frame and React screens look identical in both. Update downloads show Downloading update… with a moving bar and show byte counts only once the total size is known. Every loading step on the way into the game—first frame, update checks, session check, and world preparation—uses the same boot screen, matching the native launch screen. Connection loss keeps the world visible: after a short grace it dims slightly and holds input, and a compact top-center pill reads Reconnecting… or Offline · Waiting for network. A planned server restart shows the same pill (Server updating…) while the world stays interactive. Only an exhausted reconnect window or a failed startup uses the boot screen, with one clear action. Reconnecting after a server restart does not reload the client. The faint corner version watermark copies full release details when tapped and turns red for a confirmed client or server mismatch. Native builds also show the app version, build, and active bundle. During the internal OTA acceptance test, the native watermark and copied details include OTA TEST 2. Planned service restarts keep the world visible. Runtime art downloads use the same boot screen with measured progress, retry, and a choice to continue with the current version; player-facing copy calls every download an update and never names artwork.</p>
      </div>
      <div className="ui-standards-status-preview">
        <PlannedUpdateStatus />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen state="reconnecting" presentation="embedded" onReconnect={() => undefined} />
      </div>
      <div className="ui-standards-status-preview">
        <UpdateBanner
          update={{ version: "1.4.2", sizeBytes: 6_700_000, autoApplyAt: Date.now() + 11_000 }}
          embedded
          onApply={() => undefined}
        />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen
          state="update_ready"
          update={{ version: "1.4.2", sizeBytes: 3_400_000, autoApplyAt: Date.now() + 7_000 }}
          presentation="embedded"
          onReconnect={() => undefined}
        />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen state="update_applying" presentation="embedded" onReconnect={() => undefined} />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen
          state="bundle_loading"
          phase="downloading"
          progress={{ loadedBytes: 0, totalBytes: null }}
          presentation="embedded"
          onReconnect={() => undefined}
        />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen
          state="first_run_ready"
          downloadBytes={275_000_000}
          presentation="embedded"
          onReconnect={() => undefined}
        />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen
          state="first_run_loading"
          phase="downloading"
          progress={{ loadedBytes: 96_000_000, totalBytes: 275_000_000 }}
          presentation="embedded"
          onReconnect={() => undefined}
        />
      </div>
      <div className="ui-standards-status-preview">
        <ClientUpdateHelpScreen presentation="embedded" onTryAgain={() => undefined} />
      </div>
      <div className="ui-standards-status-preview">
        <ConnectionRecoveryScreen
          state="content_loading"
          progress={{ loadedBytes: 48 * 1024, totalBytes: 108 * 1024 }}
          presentation="embedded"
          onReconnect={() => undefined}
        />
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="shop-standards-title">
      <h4 id="shop-standards-title">Shop cards, tiles and stepper</h4>
      <p className="muted">The Glimmer Shop shows items on square art tiles (swag weapons centered, long ones tilted 45 degrees, slings and shuriken upright), a name, a subtitle and the Glimmer price. The item panel is fixed to the viewport (bottom sheet on phones) with the quantity stepper (1 to 99) and purchase buttons pinned to its footer. Glimmer packs show the built-in bonus.</p>
      <div className="shop-grid">
        <button type="button" className="shop-card" onClick={ignore}>
          <div className="shop-art-frame"><span className="shop-tag shop-tag-new">New</span></div>
          <span className="shop-card-name">Example item</span>
          <span className="shop-card-sub">Sword · Warrior</span>
          <span className="shop-card-price"><span className="shop-price"><CurrencyGlyph kind="glimmer" />1,000</span><small>Shop only</small></span>
        </button>
        <div className="shop-pack">
          <span className="shop-pack-gem"><CurrencyGlyph kind="glimmer" /></span>
          <span className="shop-pack-amount">1,050</span>
          <span className="shop-pack-split">1,000 <em>+ 50 bonus</em></span>
          <span className="shop-pack-pct">+5% extra</span>
          <span className="shop-pack-first">First purchase: +1,050 more</span>
          <GameAppButton variant="primary" onClick={ignore}>$9.99</GameAppButton>
        </div>
      </div>
      <QuantityStepper value={shopQuantity} onChange={setShopQuantity} />
      <p className="muted">An app can add one more action to the bottom nav row with the shell's navTrailing slot (the Shop's Cart). It takes the same framed button style as Back and Return to Game, on the phone footer and the desktop window footer, and keeps its label and count badge.</p>
      <GameAppFooter>
        <PhoneMenuFooterButtons backLabel="Back to Game" onBack={ignore} onReturnToGame={ignore} />
        <button type="button" className="phone-menu-nav-trailing shop-cart-nav" onClick={ignore}><span className="phone-menu-nav-label">Cart</span><span className="shop-cart-count" aria-hidden="true">2</span></button>
      </GameAppFooter>
    </section>

    <section className="ui-standards-section" aria-labelledby="kitchen-standards-title">
      <h4 id="kitchen-standards-title">Kitchen recipe types</h4>
      <p className="muted">Recipes and Queue use the housed primary rail. Ingredients use these shared scrollable subtabs: ordinary animal cuts and fish, simple provisions, hearty provisions, and advanced ingredients. Each recipe retains its actual Simple Food yield.</p>
      <KitchenRecipeTabs category={kitchenCategory} onChange={setKitchenCategory} />
      <p className="muted">World city and facility labels keep their authored screen-pixel text sizes throughout camera zooms, including global-to-local transitions, and follow the current artwork hitbox with a 2px gap.</p>
    </section>

    <section className="ui-standards-section" aria-labelledby="construction-standards-title">
      <div>
        <h4 id="construction-standards-title">Player construction countdown</h4>
        <p className="muted">Ordinary player-built structures—Manor; Furnace, Tannery, Loom, and Kitchen; and city houses, facilities, and upgrades—share one authoritative 30-second duration. Desktop, phone, and world presentations derive continuously from the synchronized server clock and stored deadline. Local zero is <em>Finalizing…</em> until the server confirms completion. Personal flag builds, city founding or conversion, Kingdom projects, production or crafting jobs, harvesting, travel, and combat or cooldown timers keep their own semantics.</p>
      </div>
      <div className="ui-standards-status-preview">
        <WorldActivityTimerPlate
          kind="furnace"
          ariaLabel="Furnace construction"
          remainingTimeLabel="12.4s"
          progress={0.58}
          priority={1}
        />
      </div>
      <div className="ui-standards-status-preview">
        <FieldBuffStrip buffs={[
          { buffId: "anti_venom", endsAtLocalMs: Date.now() + 59 * 60_000 },
          { buffId: "battle_draught", endsAtLocalMs: null }
        ]} />
      </div>
      <p className="muted">Potion buffs (Anti-Venom, Spark Tonic, Battle Draught) show as text chips in the gameplay status stack under the activity timer: name plus whole-minute remaining, or While Aggressive for the Battle Draught. The server sends the full list on every change and at login; timed deadlines are translated to the local clock once.</p>
      <div className="ui-standards-card-grid">
        <GameAppCard title="Manor" badge="Building">
          <p role="status">Constructing · 30.0s remaining</p>
          <small>Authoritative deadline · local zero: Finalizing…</small>
        </GameAppCard>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="world-zone-banner-standards-title">
      <div>
        <h4 id="world-zone-banner-standards-title">Zone entry banner</h4>
        <p className="muted">Entering a new biome shows two short, passive lines at the top of the gameplay status stack: the friendly biome name, then the local season and a height or depth word. It sits on a small parchment plate in the active menu theme (folio material, brass inner rule, display-face title), ignores input, fades in over 0.4 seconds, holds about 5 seconds, and fades out over 2 seconds. On phones it sits just below the chat bar; on desktop it leads the top status stack. It appears after 1.5 seconds in a new zone (0.5 seconds after login, travel, or leaving an interior), never repeats the zone the player was last told about, and skips a zone announced in the last 90 seconds. It waits during combat (including 6 seconds after taking damage), death, travel, and the World Map, shows 1.2 seconds after they end, and is dismissed when any of them start. Land biomes and seasons come from the bundled world zone lookup; water (Lake, Coast, Open Ocean, river water) comes from the server's World lookup at the player's authoritative position, asked when the zone settles, after the player stops moving for about a second, and once per connection. The banner changes only when the biome changes; shore tags never trigger it. The banner always keeps its regular two lines; a first discovery adds the region celebration card below it (next section). The server records discoveries (16 regions, Wilds excluded).</p>
      </div>
      <div className="ui-standards-status-preview">
        <WorldZoneBanner
          preview
          banner={{ sequence: 0, content: { key: "pinewild", title: "Pinewild", detail: "Early Winter · Highland" } }}
        />
        <WorldZoneBanner
          preview
          banner={{ sequence: 1, content: { key: "open_ocean", title: "Open Ocean", detail: "Late Summer · The Deep" } }}
        />
        <WorldZoneBanner
          preview
          banner={{ sequence: 2, content: { key: "frozen_waste", title: "Frozen Waste", detail: "Midwinter · Lowland" } }}
        />
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="region-celebration-standards-title">
      <div>
        <h4 id="region-celebration-standards-title">Region discovery and achievement card</h4>
        <p className="muted">Discovering a region for the first time keeps the regular zone banner and adds a second passive parchment card directly below it in the same slot (phone: under the chat bar; desktop: top status stack), using the banner's plate (folio material, brass inner rule, display-face title). The eyebrow reads "NEW REGION DISCOVERED", followed by the region's achievement title in the display face, a brass rule that sweeps outward, "+N points", and "Honor: X" when the achievement has one. It enters about 0.4 seconds after the banner, scales in over 0.35 seconds, holds 6 seconds, and fades over 2 seconds; reduced motion uses opacity only. Further unlocks from the same discovery (for example Cartographer) and generic achievements (for example Bitter Blood) use the same card with the eyebrow "ACHIEVEMENT UNLOCKED" and play one after another in a queue. The queue holds during combat (including 6 seconds after damage), death, travel, and the World Map, and a card cut off by them replays in full afterwards. The card ignores input and each card is announced once through a polite live region.</p>
      </div>
      <div className="ui-standards-status-preview">
        <WorldZoneBanner
          preview
          banner={{ sequence: 3, content: { key: "plains", title: "Plains", detail: "Early Autumn · Lowland" } }}
        />
        <RegionCelebration preview card={celebrationCardsFor({
          biome: "plains",
          achievements: [{ id: "legend_region_plains", title: "Endless Horizon", points: 10 }]
        })[0]!} />
        <RegionCelebration preview card={celebrationCardsFor({
          biome: "plains",
          achievements: [{ id: "legend_regions_10", title: "Cartographer", points: 50, honor: "Cartographer" }]
        })[1]!} />
        <RegionCelebration preview card={achievementCard("bitter_blood", "Bitter Blood")} />
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="world-zone-readout-standards-title">
      <div>
        <h4 id="world-zone-readout-standards-title">World Map region readout</h4>
        <p className="muted">A small passive parchment plate in the World Map's bottom-left corner, beside the recenter control, using the zone banner's plate (folio material, brass inner rule, display-face title). It shows the region under the player with any shore tags from the server (Shoreline, Lakeshore, Riverside, River), for example "Plains · Riverside", then the local season with a height or depth word, and "Regions discovered X / 16" once the server has sent the player's discoveries. Long names truncate with an ellipsis. It is hidden while a World Map trip is in progress and whenever the zone lookup or the player's position is unavailable.</p>
      </div>
      <div className="ui-standards-status-preview">
        <WorldZoneReadout readout={{ title: "Plains · Riverside", detail: "Early Autumn · Lowland", discovered: 7 }} />
        <WorldZoneReadout readout={{ title: "Open Ocean", detail: "Late Summer · The Deep", discovered: null }} />
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="world-map-biomes-layer-standards-title">
      <div>
        <h4 id="world-map-biomes-layer-standards-title">World Map Biomes layer legend</h4>
        <p className="muted">The World Map Layers menu opens on the Biomes tab (BIO), which lists the 13 land biomes in the same order and with the same names as the zone banner, discovery list, and Creature Book habitat maps: Jungle, Pinewild, Greenwood, Frostwood, Plains, Savanna, Marsh, Highmeadow, Scrubland, Badlands, Steppe, Tundra, and Frozen Waste. Each row is a checkbox with a natural map-tone swatch; the overlay draws at 38% opacity. The Elevation (ELE) tab lists five tiers with their ranges: Low under 500 m, Moderate 500 m to under 1,500 m, High 1,500 m to under 2,500 m, Alpine 2,500 m to under 5,000 m, and Summit 5,000 m and above; the zone banner names them Lowland, Upland, Highland, Peaks, and Summit, and Summit stays winter all year outside the tropics. Water biomes stay in the Ocean Depth (SEA) and Water (HYD) tabs, beside Elevation (ELE) and Terrain (TER). Badlands and Steppe are the same desert ecoregions split at 35 degrees of latitude.</p>
      </div>
      <div style={{ position: "relative", containerType: "inline-size", minHeight: 300 }}>
        <WorldMapLayerControl
          open
          activePanelId="environment"
          activeOverlayGroupId="environment"
          selections={createDefaultWorldEnvironmentOverlaySelections()}
          error={null}
          onPanelChange={ignore}
          onActiveGroupChange={ignore}
          onCategoryChange={ignore}
        />
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="world-label-standards-title">
      <div>
        <h4 id="world-label-standards-title">World labels</h4>
        <p className="muted">Cities use 12px labels and active city structures use 10px labels, with optional 8px supporting text, all passive and top-centered 2px below the exact unassisted hitbox. Personal buildings put the owner possessive on the supporting line; monuments put Tier N there; other structures stay one canonical title-cased line. World sprite sizing and the persistent-detail fade use the latitude-normalized ground-scale zoom (zoom + log2(1 / cos(latitude)), so the same ground framing gives the same sprite pixel size at any latitude); the globe band and camera stay on raw MapLibre zoom. Persistent low-level detail is hidden at map zoom 13 or below (measured in ground-scale zoom): remote player names, eligible mob overhead health bars, and every active city-structure label fade in with clamped smoothstep easing through zoom 13. The local player never receives a world-space health bar; full-health passive mobs plus context-free remote players and military groups stay hidden, while damaged or authoritative target/active-context bars remain readable. In the globe band from zoom 8 to 4, both map paths use the same continuous 36px visible-art contract after authored PlayerRenderer scaling and hide player health bars; the overlapping globe values use the same absolute MapLibre camera zoom. If shell viewport or latitude differs, compare normalized globe framing as 2^zoom / (cos(latitude) × the shorter usable viewport edge), with no map-floor offset. City labels, including NPC Goblin Villages, stay visible, and transient combat feedback remains independent.</p>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="world-status-tile-standards-title">
      <div>
        <h4 id="world-status-tile-standards-title">World status tiles</h4>
        <p className="muted">Active status effects under any character or mob render as 20px square tiles with a dark rounded background, a subtle 1px border, and a centered 14px icon. Tiles sit in an even 3px-gap row centered below the health bar, wrap to a new centered row after six, and never overlap the name or health bar.</p>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="world-png-zoom-standards-title">
      <div>
        <h4 id="world-png-zoom-standards-title">World PNG zoom</h4>
        <p className="muted">Giving Trees use fruiting artwork while berries are available and plain artwork after gathering. Former resin-bearing trees now supply berries; the remaining Giving Trees stay plain without a secondary harvest. Both retain the authored tree anchor, scale, and hitbox; Willow and Chinese Pistache keep their own art. Giving Berry item art is shared by inventory, quick slots, drops, and healing feedback.</p>
        <p className="muted">The World Map (Atlas) opens on a list view by default on desktop and phone. A fixed List / Globe view segmented control (the canonical subtabs rail) sits directly under the Atlas tabs in both views, so its size, position and the header never change when switching; the last chosen view is remembered per device, and any trip switches to the globe for the travel animation. The list has two sections that hide when empty: Major destinations (the Albuquerque anchor city first if it exists, then the largest cities by members up to WORLD_MAP_MAJOR_DESTINATION_LIMIT, currently 1 so Albuquerque is the only hub; shown and travellable for every player without discovery) and Your destinations (your city, Manor, Castle, Atlas Shrines, then other discovered cities). Each row is only name, distance and Hunger cost, and a Travel action that uses the normal World Map travel flow; the list scrolls with no native scrollbar. Major destinations carry a small bronze hub glyph (ring with four spokes) on the list row, the globe marker and the Choose Destination rows. The header keeps Relocate, Social visibility (both views) and Search (globe only); Manor and Kingdom jumps are list rows, and the map keeps only Layers, Recenter and the developer button. The surface behind the view bar and map frame is the Atlas page parchment. Globe markers follow three zoom tiers. Far (below zoom 5): no building art, destinations are small dots (hubs a larger bronze dot with the hub glyph), overlapping dots merge into one compact count marker that shows the hub glyph when it holds a hub (tap it to choose a destination), and your own sprite stays visible at about 65% size with its bronze ring, drawn beneath destination markers and stepped aside when it overlaps one. Mid (zoom 5 to 7.5): small building icons scaled with zoom, hubs never merge, no names. Close (zoom 7.5 and up): full icons with names. The Atlas map zooms to city level (zoom 12). Travel starts with a single eased camera move (at most 1.1s, 0.25s with reduced motion, never more than 40% of the trip) to the midpoint of the route at a zoom that frames both ends (globe level for routes over 6,000 km); from the list view the globe first jumps onto the player. The route line then animates over the remaining server-timed trip, and arrival eases to the destination with a gentle push-in (at most zoom 5); the route frame is capped at a regional zoom (4.5) so short hops keep their surroundings, and every trip takes at least 3s. The intro never changes the server-timed duration. In the mid and close tiers major hubs are never clustered; the hub glyph is a light badge with a bronze ring on the marker's top-right corner. Your own marker is a small sprite with a bronze ring on a layer below destination labels, and steps aside when it sits on a destination. Social visibility and Layers open as opaque parchment popovers above the whole Atlas panel (Layers is a bottom sheet on phones): full-word subtabs (Biomes, Elevation, Terrain, Ocean Depth, Water) on the scrollable subtabs rail, a two-column swatch grid, and one All / None control. Every globe marker, cluster, label and travel marker (and the route line) is hidden when its point is on the far side of the globe, using the 3D dot product between the point and the camera position (pitch included), and clusters are built only from near-side destinations.</p>
        <p className="muted">World Map destination PNGs and clusters use transparent hit targets in every UI profile, with no button card behind the art. Labels and count badges keep their own readable surfaces. World Map Travel warms the destination immediately while the player dances along the dotted route; the journey takes 15 seconds at the maximum globe distance and scales linearly for shorter trips. The route must finish before requesting arrival, and only authoritative arrival reveals the destination.</p>
        <p className="muted">Persistent building artwork uses one shared map zoom curve. The authored anchor and hit geometry stay attached to the same PNG frame as its rendered size grows or shrinks, so Tannery, Loom, Cistern Warrens, and every other world facility remain consistent across zoom levels. Ground item drops use their authored ground height against the canonical player in outdoor, Manor, and dungeon scenes; the default normalized hit frame follows that visual frame, with custom geometry only when explicitly unlocked in Appearance Studio.</p>
      </div>
      <div className="ui-standards-card-grid">
        {TERRITORY_STRUCTURE_TYPES.map((type) => {
          const definition = TERRITORY_STRUCTURE_CATALOG.structures[type]!;
          const visual = TERRITORY_STRUCTURE_CATALOG.packs.stock!.structures[type]!;
          return <GameAppCard key={type} title={definition.displayName} badge="Stock Flag Pack">
            <p>Flags Studio · master scale {visual.root.scale} · {visual.pieces.length} registered PNG pieces</p>
            <p>Fixed ground anchor (0, 0) · independent {definition.interaction.width} × {definition.interaction.height} tap area shared by every cosmetic pack.</p>
            <p>Components: {visual.pieces.map((piece) => `${piece.name} (${piece.role})`).join(", ")}. PNG alpha supplies transparency; there is no separate mask layer.</p>
            <p>Clone Stock creates all four types. Component transforms, layer order and original/control/fixed tint stay cosmetic; burning and kingdom-emblem visibility remain state-owned. One root and the complete tap rectangle follow shared world zoom.</p>
          </GameAppCard>;
        })}
        {worldPngZoomSamples.map(({ label, presentation }) => {
          const defaultHeight = Math.round(presentation.height * RUNTIME_PNG_PRESENTATION_CATALOG.masterScale * 10) / 10;
          return (
            <GameAppCard key={label} title={label} badge={`${presentation.width} × ${presentation.height} px authored`}>
              <p>Shared map zoom · {defaultHeight}px at the default master scale</p>
              <small>Base zoom {WORLD_OBJECT_ZOOM_POLICY.baseZoom}; {Math.round(WORLD_OBJECT_ZOOM_POLICY.minScale * 100)}% minimum floor; {WORLD_OBJECT_ZOOM_POLICY.maxScale === null ? "no upper cap" : `${Math.round(WORLD_OBJECT_ZOOM_POLICY.maxScale * 100)}% maximum`}.</small>
            </GameAppCard>
          );
        })}
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="skill-slot-standards-title">
      <div>
        <h4 id="skill-slot-standards-title">Skill System V3 action slots</h4>
        <p className="muted">The live V3 action surface keeps Basic Attack, General 1, and General 2 in one shared model. Classes have rank effects only; there are no class active slots. General assignments are durable skill authority, independent of inventory and backpack capacity, and route Q/W on desktop while phone uses the same compact controls.</p>
      </div>
      <div className="ui-standards-skill-preview">
        <SkillSystemV3CombatControls
          snapshot={skillControlsSample}
          layout="desktop"
          disabled={false}
          synchronizedNow={() => skillControlsSample.serverTime}
          onUseGeneral={() => undefined}
        />
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="phone-hud-standards-title">
      <div>
        <h4 id="phone-hud-standards-title">Phone gameplay HUD</h4>
        <p className="muted">The touch HUD uses a 52px three-zone footprint plus the safe-area inset: HP/EXP/Hunger on the left, a slightly raised circular Menu medallion in the center, and player state, carry kg, and gold on the right. Both sides share one ledger row: icon, 6px recessed meter, right-aligned tabular value at 12–14px; gold uses a dotted leader. Large carry values compact while accessible names and titles retain exact values; the economy panel keeps its Inventory action. Tap the vitals to recenter and hold for the World Map; hold the bag to show or hide quick slots; hold Menu for the player's shortcut app. Construction and Crafting cards show each material as its PNG and count: in the success tone when the player has enough, in the error tone with have/need when short, with an aria-label such as "Wood 100, have 12, missing 88". The card carries one status mark, a check mark when it can be built or crafted and an X when it cannot: compact, unboxed, right-aligned on the card title row, with state words like Unbuilt or Available left out (a finished building reads Built instead). Non-material info such as build time sits in the chip row as dashed, muted metadata. A blocked card action keeps the normal button colour at reduced emphasis. Any item picture without a visible name (material chips, item icons) names itself in a small tooltip: on hover or focus on desktop, on a ~450ms long press on touch, which never triggers the tap action. The requirement sentence is never repeated, only a non-material blocker such as "Build a Manor first." shows. Flag/buoy build (tap to place, hold for planning) and Giving Berry heal start in the bottom quick-slot row; nothing else floats over the map. Tapping an empty slot opens grouped choices (Building, Healing, Fishing, then carried Gear or Other items) before the items themselves. A developer-only Gear slot preview fans up to 3 sets sideways on touch-down; slide and release to equip. There is no extra navigation row or Items button. Phones run the tray edge to edge through the safe area with no gap beneath it; iOS hugs the display with lower corners that follow the screen curve; screens over 700px float a bounded tray. Values never sit inside separate brown or black number boxes; text, glyphs, and timer plates inherit the selected theme.</p>
        <p className="muted">Desktop has no full-width bar: a top-left unit frame (portrait medallion and level badge over the HP/EXP/Hunger ledger) with party and quick slots below it, a top-centre chat plaque, a centered command bar with every destination in one row of icon-over-label buttons, and a bottom-right pack frame for state, carry, and gold. Desktop has no Menu button; when the scaled width is below 1180px the command bar shows icons only with names in hover titles. Settings › Appearance › Interface size (a 50–150% slider in 5% steps, applied on release) scales the HUD and windows but never the map. It fills the browser viewport and requires at least 1100 × 600 CSS pixels plus a fine pointer without touch/coarse capabilities; tablets and hybrid touch devices retain their full-screen touch shell and Menu action.</p>
        <p className="muted">Messages and Atlas Chats float above the world without a mobile protection sheet. Drag the title bar or resize from any invisible corner hit area; focused title-bar/corner controls support Arrow keys at 10px, or 40px with Shift, while the opposite corner stays fixed under the clamps. Windows clamp above the HUD, remember bounds for this session, and reset on reload. Existing Messages minimize, restore and dismiss controls remain. Mobile/tablet chat keeps its full-screen keyboard-safe behavior. All presentations share domain state, routes, handlers and utility-slot persistence.</p>
        <p className="muted">Atlas Chats chrome: its own slim modern header, not the Ledger header (52px plus the top safe-area inset; no medallion, eyebrow or small-caps title): a plain bold Atlas Chats title, a small "N online" pill with a green presence dot that opens the online list, then an icon Settings button (sliders glyph) and a chevron Back button (Close on desktop windows) of the same height (36px, 40px on touch). The panel is one shrinkable grid column, so room tabs scroll inside their own strip, long unbroken message text wraps, and Send always fits on narrow iPhone widths. Room tabs sit directly under it as a light text strip with no tray: sentence-case tabs, the active room in bronze with a 2px bronze underline, hover tint on desktop, horizontal scroll without a visible scrollbar, unread badges kept, 44px tall on touch. There is no Follow Chat toggle: scrolling up pauses live following and reaching the bottom or pressing the new-messages button resumes it. In the composer the 0/400 counter appears only from 350 characters, and Send uses the same compact button style. Chat message rows: a group starts with the crest, name in the bronze accent and a small muted time on one line; continuation rows stack directly under the body and show their own time in the crest gutter on hover or long-press. Groups sit 10px apart with a faint hairline between different speakers. Your own rows use a muted name, never bubbles. A day change shows a centered hairline with Today, Yesterday or the date, not a time. Actions (translate 文A, react, •••) are a floating toolbar pill in the row's top-right that overlays the text: it appears on mouse hover or keyboard focus, and on touch only after a 500ms long-press, with 44px targets. A translation someone already requested appears automatically for every viewer whose language matches, as an indented tinted panel headed Translated from (language) with Show original; it is skipped when the message is already in the viewer's language.</p>
        <p className="muted">Light theme uses strong brown body text and readable brown supporting labels, including login, Help, Credits, legal links and disabled controls. Text/muted tokens meet 4.5:1 on paper states. Resource values have no separate brown or black box; softened active-theme bars and direct paper ink keep partial bars readable while semantic fills remain unchanged.</p>
        <p className="muted">HUD chrome follows the Game Menu recipe: quick-slot tiles are gilded parchment plaques (brass edge, inner brass rule, corner brackets, flush to the screen edge) with menu-ink glyphs; locked slots are recessed engraved sockets with a small brass lock instead of a ghost. The dock keeps one icon | meter | value grid on both sides with 16px ink icons, distinct fills (HP green, XP brass, hunger amber, carry bronze, full red), the combat state label as the value at rest (timer meter only while active), and gold as a plain coin plus value aligned with the carry row (no pill). Gauges are 9px grooves with faint quarter ticks. On the phone dock the left ledger is HP (value inside a taller bar) over XP, and the right is bag weight and gold on one line (separated by a small brass diamond) over the hunger bar, mirrored so XP and hunger read as a pair; XP and hunger are bars only. The touch dock runs edge to edge with no map gap at the sides or bottom: on iOS its lower corners are the display radius itself (inset 0) and readouts are padded clear of the curve, on Android it is square at the bottom. Menu and both ledgers give a pressed response (the medallion sinks and springs back, ledgers darken) without changing tap or hold behaviour. The chat strip has a thin brass inner rule and a bronze presence dot.</p>
        <p className="muted">Combat state (aggression or protection) shows nothing at ease: no label, no row. Afloat (water travel) is the one persistent state in that slot: when no combat state is active the phone tag reads Afloat (no ring, sea-blue underline) and the PC adventurer card shows an Afloat text chip; an active combat state takes the slot until it ends. While active it is a ring around the phone Menu medallion (a recessed groove that drains clockwise from 12 o'clock, ember red for aggression, pale gold for protection) with a hanging brass-edged seconds tag at the top that pulses gently in the last 3 seconds, and on PC a chip on the adventurer card; the PC bottom bar is one framed unit (nav, a brass-soft divider, carry and gold) and its Settings button reads Settings. PC chat is capped at 620px and the adventurer card, chat and bar share the brass corner brackets.</p>
        <p className="muted">Settings &amp; Support is a canonical GameAppShell with housed Gameplay, Support, Account, and About sections plus contextual subtabs. Its body is the only scroll owner and the fixed shell footer keeps Back / Return navigation safe-area aware. Opening the shell focuses its container so native Visible rows and Tap assistance pickers stay closed until explicitly tapped. During live phone editing, the full instruction panel collapses into compact Accept / Cancel controls in the hidden lower HUD space while the measured paired-row handles remain over the gameplay track; desktop retains the full panel and keyboard behavior.</p>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="hud-lanes-standards-title">
      <div>
        <h4 id="hud-lanes-standards-title">HUD lanes</h4>
        <p className="muted">Transient feedback has fixed, non-overlapping lanes; nothing may cover the chat bar, party widget, unit frame, hotbars or bottom bar. Notices are one short line each in the top-centre lane under the chat row (max 3, each fades after about 3.5 seconds, only exact duplicates merge). Every reward source (mob drops, harvests, chests, gold, XP, skill XP) shares the loot feed: compact icon rows, identical rewards merge and count up, at most five rows, newest at the bottom. Desktop puts the feed on the right above the pack frame and beside the right quick slots; phone puts it on the right under the chat row, clear of the quick-slot rail. The bottom-centre slot above the dock belongs to activity timers. Mob kills and freshly opened dungeon chests reveal as a loot card above the feed rows: gold, then items by rarity with artwork, name, quantity and rarity tint, about 5 seconds (bosses 7.5 seconds, larger), at most 3 stacked, never blocking input. A looted chest stays dimmed for that player. Floating combat numbers stay in the world and are not part of the feed.</p>
        <div className="ui-standards-lane-demo">
          <HudNoticeStack notices={HUD_LANE_SAMPLE_NOTICES} label="Notice lane example" />
          <div className="hud-loot-feed" role="group" aria-label="Loot feed example">
            <LootFeedRows rows={HUD_LANE_SAMPLE_ROWS} nowMs={1_000} reducedMotion />
          </div>
        </div>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="gathering-animation-standards-title">
      <div>
        <h4 id="gathering-animation-standards-title">Gathering animations</h4>
        <p className="muted">Chopping, mining and fishing play on the layered player sprite. The tool is held in the hand on the worked object's screen side; the equipped weapon fades out and returns after. Both arms bend at the elbow on one shared arm rig (wind-up with the elbow cocked, strike snapping it straight, follow-through) and carry everything drawn on them at full thickness: skin, sleeves, armour and gloves, with the fist unchanged and no strip left on the torso. No tool means bare hands: a straight punch into trees and an overhead hammer punch onto rocks. Harvesting berries, plants, herbs and the like (and berries or sap from Giving Trees and Elder Ferns) is always bare-handed picking: reach out to the plant, grab, a quick tug back with leaves or a berry popping off the plant (never on the hand), then the hand drops back to the hip. Local player only for now; other players see no harvesting pose until their gathering snapshot carries it. While the local player builds a flag (the build countdown is running), they hold the flag (Soft Flag art at the placed flag's size, cloth in their flag colour) on the build side, heave it up and ram it into the ground about once a second with a dust puff, and it stops when the build completes or is cancelled. Reduced motion keeps a gentle, smaller version.</p>
        {gatheringPreviewOpen
          ? <Suspense fallback={<p className="muted">Loading preview…</p>}><GatheringAnimationPreview /></Suspense>
          : <button type="button" className="game-app-button" onClick={() => setGatheringPreviewOpen(true)}>Play gathering animations</button>}
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="military-animation-standards-title" style={{ display: "block" }}>
      <div style={{ display: "block", width: "100%", minWidth: 0 }}>
        <h4 id="military-animation-standards-title">Military world animations</h4>
        <p className="muted">A Bomber lowers its intact pose with a small pivot at its boots, then moves its hands to configure the grounded bomb for the five-second server planting channel. Only a confirmed successful detonation triggers its empty-handed escape; a cancelled channel never does. The preview simulates that confirmation at five seconds. A Siege faces its attacked building or the nearest attacked Tower in an area volley, both while loaded and firing. Reverse facing swaps the nearest of the two preview towers. Pause or scrub the shared production rig to inspect contact, release and recovery. Reduced motion holds a stationary action pose.</p>
        {militaryPreviewOpen
          ? <Suspense fallback={<p className="muted">Loading preview…</p>}><MilitaryAnimationPreview /></Suspense>
          : <button type="button" className="game-app-button" onClick={() => setMilitaryPreviewOpen(true)}>Play military animations</button>}
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="boss-encounter-standards-title">
      <div>
        <h4 id="boss-encounter-standards-title">Boss encounter HUD</h4>
        <p className="muted">Boss encounters use one dedicated, passive panel with the canonical health-status HealthBarTrack, a readable boss name and optional server-projected phase/deadline, plus an authoritative cast warning. Phase labels must explain authored states such as Steam / Enraged or Rest / Vulnerable. Telegraphs are bounded to the shared circle, cone, and line geometry and clear on defeat, reset, cancellation, or reconnect snapshots that no longer contain the cast. This panel is informational and never replaces target selection or action prompts.</p>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="app-standards-title">
      <div>
        <h4 id="app-standards-title">Full-screen app UI</h4>
        <p className="muted">Header, section header, body/helper copy, tabs, cards, status states, standard/destructive/icon controls, dividers, scroll regions, and fixed navigation are shared app primitives. Primary app sections use the housed rail; every secondary choice beneath it uses the canonical compact subtabs rail, including Inventory&apos;s horizontally scrollable mobile categories, Market category and order views, and Encyclopedia Normal versus Ashen appearances. Screens do not create private selector styling. Copy stays final and player-facing; it does not narrate the server or repeat visible controls. Touch and trackpad pinch do not scale document UI; pinch over the game map and wheel zoom remain map-owned, including Safari on Mac.</p>
      </div>
      <div className="ui-standards-app-preview">
        <GameAppHeader
          eyebrow="Ash Manor"
          title="Manor Actions"
          subtitle="Floor drops and authored decorations"
          closeLabel="Close example"
          onClose={ignore}
          headerAction={<GameAppIconButton label="Example utility" onClick={ignore}><span aria-hidden="true">⋯</span></GameAppIconButton>}
        />
        <GameAppBody>
          <GameAppTabs
            variant="housed"
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "requirements", label: "Requirements" },
              { id: "locked", label: "Locked", disabled: true }
            ]}
            activeTab={appTab}
            onChange={setAppTab}
          />
          <GameAppTabs
            variant="housed"
            scrollable
            ariaLabel="Long app sections"
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "activity", label: "Activity" },
              { id: "members", label: "Members" },
              { id: "drops", label: "Floor drops" },
              { id: "history", label: "History" },
              { id: "settings", label: "Settings" }
            ]}
            activeTab={longAppTab}
            onChange={setLongAppTab}
          />
          <GameAppTabs
            variant="subtabs"
            scrollable
            ariaLabel="App subsection example"
            tabs={[
              { id: "all", label: "All" },
              { id: "consumables", label: "Consumables" },
              { id: "resources", label: "Resources" },
              { id: "equipment", label: "Equipment" }
            ]}
            activeTab={appSubtab}
            onChange={setAppSubtab}
          />
          <GameAppSectionHeader
            eyebrow="Shared section heading"
            title="Current records"
            description="Body and helper copy stay compact and readable on every app surface."
            meta="3 records"
            action={<GameAppIconButton label="Refresh records" onClick={ignore}><span aria-hidden="true">↻</span></GameAppIconButton>}
          />
          <GameAppButton type="button" onClick={ignore}>Standard action</GameAppButton>
          <GameAppButton type="button" variant="destructive" onClick={ignore}>Destructive action</GameAppButton>
          <GameAppDivider />
          <GameAppScrollRegion className="ui-standards-scroll-sample" ariaLabel="Scrollable example">
            <GameAppText tone="body">Scrollable content keeps one intentional owner while pinned shell controls remain outside.</GameAppText>
          </GameAppScrollRegion>
          <GameAppText tone="helper" as="small">Helper text explains an unavailable or disabled state without replacing the action label.</GameAppText>
          <div className="ui-standards-state-grid">
            <GameAppState variant="loading">Loading records…</GameAppState>
            <GameAppEmptyState>No records yet.</GameAppEmptyState>
            <GameAppState variant="disabled" title="Unavailable">Connect to inspect this section.</GameAppState>
            <GameAppState variant="error" title="Could not load">Try again when the service is available.</GameAppState>
          </div>
          <div className="ui-standards-card-grid">
            <GameAppCard title="Floor drop" badge="x5400" action={<GameAppActionBar><GameAppButton variant="primary" type="button">Pick up</GameAppButton><GameAppCloseButton label="Dismiss example" /></GameAppActionBar>}>
              <p>Authoritative item PNG and quantity</p>
            </GameAppCard>
            <GameAppCard title="Decorations" badge="Scrollable"><p className="muted">Choose, move, or store authored fixtures.</p></GameAppCard>
            <GameAppCard title="Loading" badge="Loading"><p role="status">Loading Manor actions…</p></GameAppCard>
            <GameAppCard title="Unavailable" badge="Unavailable"><p role="alert">Manor actions unavailable.</p></GameAppCard>
          </div>
          <GameMessageBox
            title="Readable history message"
            meta={<time dateTime="2026-09-01T12:00:00.000Z">Sep 1, 2026</time>}
          >
            <p>Use the canonical message box for announcements, release notes, and conversations.</p>
          </GameMessageBox>
          <section className="ui-standards-progression" aria-labelledby="progression-browser-example">
            <div><h4 id="progression-browser-example">Skill ledger</h4><p className="muted">The Skills & Professions app is titled Progression and has five housed tabs in one icon-over-label rail (Class, Skills, Knowledge, Trades for Professions, Awards for Achievements; short labels keep all five on one phone row, accessible names stay in full, no wrapping or scrollbar). It opens on Class and remembers each player's last tab in local storage. The SP available, spent and character level summary sits at the top of Class, Skills and Knowledge. Class: a hero card for the committed class (icon, title such as Master Warrior once mastered, level, a 1 to 5 rank track, the next rank's SP and spent-SP gate and what it gives), Rank up and Change class actions, then every rank's effects with unlocked, next and locked rows; effects the server does not run yet read Coming soon, dimmed. Druid keeps Replenish. With no class chosen it shows a written empty state and the four discipline class paths (Rank r/3 or Open). Skills: a discipline picker (the housed tab rail with an optional icon, short name and detail line such as 2/3, plus a brass pip counting skills you can buy now) selects one discipline card at a time, defaulting to the most-invested discipline and remembered per player. Each card stacks its tiers (requirement stated once per tier) with plaque skill tiles: framed colour icon, name, branch, rank dots, status line, and a Needs-skill chip for each skill prerequisite. Tiles read learned (brass frame, rank badge), ready to buy (brass glow and dashed icon frame), maxed (gilded frame) or locked (paper tile, desaturated icon, lock badge; never a silhouette). Knowledge: World Knowledge grouped by the dungeon that issues its token, each entry with its icon (an empty slot when it has no art, never a monogram), effect, token progress such as Raptor Scale 2/5 from the inventory, and a state chip (Locked, Ready to turn in, Can learn, Learned, Maxed); pending entries read Coming soon, dimmed, with no numbers. Hidden Provoke appears as a locked cell that cannot be bought. Skill, discipline, knowledge, class, and trade details share one header (icon, name, rank and state, with the spend plaque top right and the single blocking requirement directly beneath) and open in a bottom sheet on phone or a docked side panel on desktop with the ledger and its scroll position kept; skill and discipline ranks lay out as Level columns that stack on narrow sheets.</p></div>
            <SkillLedger snapshot={skillControlsSample} onSelectSkill={ignore} />
          </section>
          <section className="skill-v3-class-block" aria-labelledby="rank-ladder-example">
            <h3 id="rank-ladder-example">Rank ladder</h3>
            <p className="muted">RankLadder is the one list for what each rank gives, used by the Class tab's Rank effects and by every profession detail. Rows are separated by thin rules, like the Class sheet; only the current rank is framed (gilded double frame, says Current), the rank being worked toward says Next, earned ranks read in full ink and later ranks are muted and say Upcoming. Tags are square. Milestone tiers show a badge, a right-aligned detail carries cost or XP, and not-yet-live effects are dimmed and tagged Coming soon.</p>
            <RankLadder entries={[
              { key: 1, title: "Rank 1", state: "earned", meta: "1,000 XP", name: "Steady Hands", lines: [{ key: "a", content: "+2% yield" }] },
              { key: 2, title: "Rank 2", state: "current", badge: "Tier I", meta: "3,000 XP", name: "Careful Work", lines: [{ key: "a", content: "+3% speed" }] },
              { key: 3, title: "Rank 3", state: "next", meta: "7,000 XP", name: "Strong Swing", lines: [{ key: "a", content: "+4% speed" }, { key: "b", content: "Bonus effect", soon: true }] },
              { key: 4, title: "Rank 4", state: "upcoming", meta: "12,000 XP", name: "Keen Eye", lines: [{ key: "a", content: "+5% yield" }] }
            ]} />
          </section>
          <section aria-labelledby="legend-journal-example">
            <h4 id="legend-journal-example">Achievements journal</h4>
            <p className="muted">The production journal matches Skills: a prestige summary, one compact search row (search, difficulty, status), pinned goals, goals within reach, and a card grid of categories and quest journeys. Goal rows show a thin progress bar and open their objectives, reward, and Pin action in the shared detail sheet; twelve rows show at a time. Objective bars expose clamped 0–100 progress. Quest locks name their predecessor chapters. Pins belong to the current character in this browser; journal honors are collected distinctions, not equipped titles. Goals complete once, with fixed higher tiers and three-chapter journeys. Existing gameplay achievements such as Bitter Blood use the same searchable, pinnable goal rows and retain their original reward authority.</p>
            <LegendJournalView snapshot={{
              playerId: "ui-standards-journal",
              metrics: { kills_total: 240, harvests_total: 85, species_seen: 6 },
              completed: {},
              newlyCompletedIds: [],
              serverTime: 1_800_000_000_000
            }} />
          </section>
          <GameAppActionBar>
            <GameAppBackButton type="button" label="Back to Cleave" onClick={ignore} />
            <GameAppButton type="button" disabled>Requirements not met</GameAppButton>
          </GameAppActionBar>
        </GameAppBody>
        <GameAppFooter>
          <PhoneMenuFooterButtons backLabel="Back to Menu" onBack={ignore} onReturnToGame={ignore} />
        </GameAppFooter>
      </div>
    </section>

    <section className="ui-standards-section" aria-labelledby="game-menu-standards-title">
      <div>
        <h4 id="game-menu-standards-title">Game Menu directory</h4>
        <p className="muted">The root leads with the illustrated Adventurer entry, opening Loadout, Stats, and Kits, then one parchment sheet of twelve direct apps in three ruled sections: Adventurer (Inventory, Skills, Pets, Encyclopedia), Fellowship (Messages, Contacts, Party, Rankings) and Realm (Atlas, Crafting, Construction, Land). Every tile routes once, with no chooser popups; City and Kingdom are Atlas tabs and Relocate is the World Map header action. Notice Board and Settings &amp; Support stay one tap away as compact header icon actions beside the authoritative day/time readout. Settings &amp; Support exposes the Account → Delete Account entry and, when the server feature flag is on, the Account → Login methods entry for explicit Apple linking. Provider choices remain equally prominent on the canonical login surface; no account is linked by email automatically. Player-facing category ledgers are retired; related views stay housed in canonical app tabs, including Inventory, Progression, Social, Realm, and Notice Board. Land Management exposes Access &amp; Travel (Visit Tolls, Atlas Shrines, and Normal Passage subtabs) and Harvest Tolls (Mines and Oil Wells). The directory is a slightly darkened parchment atlas index with dark ink glyphs, fine horizontal rules, and complete visible touch targets. Read messages use deep ink without a gold edge; only unread messages carry the gold edge.</p>
        <p className="muted">Settings &amp; Support is one canonical shell: housed Gameplay, Support, Account, and About sections expose contextual subtabs for the hotbar, map, diagnostics, account/delete, credits, and legal links. Native push-enabled builds add Account → Notifications with explicit permission, account-wide categories and quiet hours, device registration, and an Open notification settings recovery action. Notification taps open the authenticated Messages category; they never accept an invitation or claim a package. The single body scroll owner and the floating Back (chevron plus "Back", same 48px height, filling the space left of Return and chevron-only when narrow) and text-only Return to Game plaques, which share the directory card's radius, brass hairline and corner brackets; Return is always exactly centred, and the band holding them is exactly as tall as the header bar (--phone-menu-bar-h) stay stable on narrow devices, and container-first focus prevents a native select sheet from opening when the app mounts.</p>
      </div>
      <div className="ui-standards-menu-preview">
        <header className="phone-menu-header phone-menu-root-header">
          <div className="phone-menu-root-heading"><span>Ash Atlas</span><h1>Game Menu</h1></div>
          <div className="phone-menu-header-actions" role="group" aria-label="Game Menu utilities">
            <GameMenuWorldTime synchronizedNow={() => Date.parse("2026-09-01T12:00:00.000Z")} />
            <button type="button" className="phone-menu-header-action phone-menu-notice-board" aria-label="Notice Board" title="Notice Board" onClick={ignore}>
              <MenuDestinationGlyph icon="announcements" />
            </button>
            <button type="button" className="phone-menu-header-action phone-menu-utility" aria-label="Settings &amp; Support" title="Settings &amp; Support" onClick={ignore}>
              <MenuDestinationGlyph icon="miscellaneous" />
            </button>
          </div>
        </header>
        <GameMenuProfileSummary data={menuProfile} onOpen={ignore} />
        <GameMenuDirectory
          destinations={menuDestinations}
          onOpenDestination={ignore}
        />
        <section className="phone-map-settings phone-account-settings" aria-labelledby="ui-standards-login-methods-title">
          <div>
            <span>Account</span>
            <h2 id="ui-standards-login-methods-title">Login methods</h2>
          </div>
          <p>Add Apple as a backup way to sign in.</p>
          <button type="button" className="game-app-button" onClick={ignore}>Link Apple</button>
        </section>
        <footer className="phone-menu-footer phone-menu-root-footer" aria-label="Return to Game">
          <button type="button" className="phone-menu-back" aria-label="Back to Game Menu" onClick={ignore}><PhoneMenuBackGlyph /><span className="phone-menu-nav-label" data-short="Back">Back to Game Menu</span></button>
          <button type="button" className="phone-menu-return" aria-label="Return to Game" onClick={ignore}><span className="phone-menu-nav-label">Return to Game</span></button>
        </footer>
      </div>
    </section>
  </section>;
}
