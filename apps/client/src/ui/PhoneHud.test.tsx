// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  WARRIOR_LEVEL_XP,
  type ClassSnapshot,
  type CombatEntitySnapshot,
  type EquipmentSnapshot,
  type ProgressionSnapshot,
  type SkillSystemV3Snapshot
} from "@ash-atlas/shared";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MobileChatOverlay,
  resetMobileKeyboardDockingForTests
} from "../mobileKeyboardDocking.js";
import { MOBILE_MENU_RETURN_EVENT } from "../mobileGameMenu.js";
import type { PhoneAction } from "../phoneActionModel.js";
import { PhoneHud, type PhoneBuildOption, type PhoneMenuDestination } from "./PhoneHud.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  resetMobileKeyboardDockingForTests();
  vi.restoreAllMocks();
});

const destinations: readonly PhoneMenuDestination[] = [
  { id: "profile" },
  { id: "contacts" },
  { id: "messages", badge: "3" },
  { id: "party" },
  { id: "classes" },
  { id: "equipment" },
  { id: "crafting" },
  { id: "build" },
  { id: "flags" },
  { id: "world-map" },
  { id: "pet-chamber", placeholder: "Pets is not available yet." },
  { id: "creature-book" },
  { id: "leaderboards" },
  { id: "miscellaneous" },
  { id: "announcements" },
  { id: "patch-notes" }
];

const makeAction = (id: string, priority: number, execute = vi.fn()): PhoneAction => ({
  id, label: id, icon: "attack", category: "combat", priority,
  preferredSide: "right", enabled: true, execute
});

const persistentProps = {
  buildOptions: [
    {
      id: "flag", category: "personal", icon: "flag", title: "Territory Flag", description: "Claim ground.",
      requirements: [
        { itemId: "wood", quantity: 3 },
        { itemId: "leather", quantity: 2 }
      ],
      guidance: "Ready to build.",
      actionLabel: "Build Flag", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "manor", category: "personal", icon: "manor", title: "Manor", description: "Place your home.",
      requirements: ["No materials", "Owned territory"], guidance: "Build inside your territory.",
      actionLabel: "Build Manor", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "decoration:shrine", category: "personal", icon: "decoration", title: "Personal Shrine",
      description: "Place a personal decoration.", requirements: ["Owned territory"],
      guidance: "Decorations are temporarily unavailable in Construction.",
      actionLabel: "Place Personal Shrine", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "city-house", category: "city", icon: "city-house", title: "City House",
      description: "Build a home on city land to join that city.",
      requirements: ["25 Wood", "15 Stone", "City territory"],
      guidance: "Stand where you want the City House built, inside city-controlled territory.",
      actionLabel: "Build City House", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "lodge", category: "city", icon: "lodge", title: "Lodge",
      description: "House your durable military units.",
      requirements: ["50 wood", "25 stone", "City territory", "Active City membership", "One per player"],
      guidance: "Stand inside your City territory to build a Lodge.",
      actionLabel: "Build Lodge", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "barracks", category: "city", icon: "barracks", title: "Barracks",
      description: "Train Infantry and Archer units.",
      requirements: ["250 wood", "200 stone", "500 City Coins", "Active City membership", "One per player"],
      guidance: "Stand inside your city territory.",
      actionLabel: "Build Barracks", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "demolition-factory", category: "city", icon: "demolition-factory", title: "Demolition Factory",
      description: "Train Bombers and Siege; produce Torches and Repair Kits.",
      requirements: ["100 iron bar", "100 sulfur", "200 cloth", "500 wood", "Active City membership", "One per player"],
      guidance: "Stand inside your city territory.",
      actionLabel: "Build Demolition Factory", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "warehouse", category: "city", icon: "warehouse", title: "City Warehouse",
      description: "Build permanent storage for city materials.",
      requirements: ["100 Wood", "75 Stone", "100 City Coins", "Mayor personal materials"],
      guidance: "Stand where you want the City Warehouse built, inside your city territory.",
      actionLabel: "Build City Warehouse", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "warehouse-upgrade", category: "city", icon: "warehouse", title: "Warehouse Upgrade",
      description: "Increase shared material capacity.", requirements: ["200 Wood", "500 City Coins"],
      guidance: "Upgrade at the Warehouse location while stationary.",
      actionLabel: "Upgrade to Tier 2", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "market", category: "city", icon: "market", title: "City Market",
      description: "Build the city-local trading venue.", requirements: ["Active Warehouse"],
      guidance: "Stand at the intended Market location while stationary.",
      actionLabel: "Build City Market", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "monument-mining", category: "city", icon: "monument", title: "Mining Monument",
      description: "Build the City's Mining specialty Monument.", requirements: ["Active Warehouse"],
      guidance: "Remain stationary during construction.",
      actionLabel: "Build Mining Monument", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "monument-forestry", category: "city", icon: "monument", title: "Forestry Monument",
      description: "Build the City's Forestry specialty Monument.", requirements: ["Active Warehouse"],
      guidance: "Remain stationary during construction.",
      actionLabel: "Build Forestry Monument", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "monument-hunting-upgrade", category: "city", icon: "monument", title: "Hunting Monument Upgrade",
      description: "Tier 1 to Tier 2.", requirements: ["Active Warehouse"],
      guidance: "Remain stationary during construction.",
      actionLabel: "Upgrade Hunting Monument to Tier 2", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "city", category: "city", icon: "city", title: "City", description: "Build a City Hall.",
      requirements: ["No materials", "Owned territory"], guidance: "Build inside your territory.",
      actionLabel: "Build City", enabled: true, disabledReason: null, execute: vi.fn()
    },
    {
      id: "kingdom", category: "kingdom", icon: "kingdom", title: "Kingdom", description: "Raise a Castle.",
      requirements: ["Owned territory", "Kingdom identity"], guidance: "Name your realm.",
      actionLabel: "Build Kingdom", enabled: true, disabledReason: null, execute: vi.fn()
    }
  ] satisfies readonly PhoneBuildOption[],
  destinations,
  menuCategory: null,
  progression: {
    playerId: "p", totalXp: 6397, level: 4, curveVersion: 1, persistenceVersion: 1,
    xpIntoLevel: 397, xpForNextLevel: 800, nextLevelTotalXp: 6800, atCap: false,
    pveStats: { maxHealth: 100, attackPower: 10, defense: 5, attackIntervalMs: 1000, attackRangeM: 2 }
  } satisfies ProgressionSnapshot,
  achievements: null,
  combat: {
    entityId: "p", kind: "player", archetypeKey: null, name: "Player", level: 4,
    regionCode: "NM", zoneId: "world:NM", lat: 35, lon: -106, maxHealth: 100,
    currentHealth: 94, lifeState: "alive", activityState: "idle", targetEntityId: null, revision: 1,
    classCombat: { activeClassId: "warrior", resource: { resourceId: "rage", displayName: "Rage", current: 0, maximum: 100, reserved: 0 }, rage: 0, maximumRage: 100, reservedRage: 0, guard: 0, bloodlust: 0, queuedAbility: null, cooldownEndsAt: {} }
  } satisfies CombatEntitySnapshot,
  classSnapshot: null,
  equipment: null,
  combatControlsDisabled: false,
  synchronizedNow: Date.now,
  walletGold: "1250",
  inventoryUsed: "1004000",
  inventoryTotal: "1200000",
  developerAccessEnabled: false,
  zoomIndicatorEnabled: false,
  mobileDefaultZoom: 15,
  tapAssistancePreference: "standard",
  layoutPreference: "automatic",
  automaticLayoutMode: "compact",
  effectiveLayoutMode: "compact",
  inputMode: "touch",
  wideOverrideBlocked: false,
  onOpenMenu: vi.fn(),
  onOpenCategory: vi.fn(),
  onOpenDestination: vi.fn(),
  onBack: vi.fn(),
  onLogout: vi.fn(),
  onZoomIndicatorChange: vi.fn(),
  onMobileDefaultZoomChange: vi.fn(),
  onResetMobileDefaultZoom: vi.fn(),
  onTapAssistancePreferenceChange: vi.fn(),
  onLayoutPreferenceChange: vi.fn(),
  onRecenter: vi.fn(),
  onOpenWorldMap: vi.fn(),
  onUseNormalAbility: vi.fn(),
  onUseResetAbility: vi.fn(),
  onUseUniversalTaunt: vi.fn()
} as const;

function ControlledHotbarSettings({
  save
}: {
  save(rowCount: number, rowPositions: readonly number[]): Promise<readonly number[]>;
}): React.JSX.Element {
  const [rowCount, setRowCount] = useState(4);
  const [rowPositions, setRowPositions] = useState<number[]>([0, 21, 42, 63, 84]);
  const latestIntentRef = useRef(0);
  const onHotbarLayoutChange = (rowCount: number, next: readonly number[]): void => {
    const intent = latestIntentRef.current + 1;
    latestIntentRef.current = intent;
    const optimistic = [...next];
    setRowCount(rowCount);
    setRowPositions(optimistic);
    void save(rowCount, optimistic).then((serverPositions) => {
      if (latestIntentRef.current === intent) setRowPositions([...serverPositions]);
    });
  };
  return (
    <PhoneHud
      {...persistentProps}
      menuView="miscellaneous"
      actions={[]}
      hotbarRowCount={rowCount}
      hotbarRowPositions={rowPositions}
      onHotbarLayoutChange={onHotbarLayoutChange}
    />
  );
}

const readyClassSnapshot = {
  playerId: "p",
  characterLevel: 15,
  activeClassId: "warrior",
  activeSubclassId: null,
  warrior: {
    classId: "warrior",
    level: 15,
    xp: WARRIOR_LEVEL_XP[15]!,
    nextLevelXp: WARRIOR_LEVEL_XP[16]!,
    completedAt: null
  },
  subclasses: [
    { subclassId: "reaver", unlocked: false },
    { subclassId: "warden", unlocked: false }
  ],
  loadout: {
    resetActives: [null, null],
    normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
    passiveTiers: [null, null, null],
    ultimateActive: null
  },
  legacyIds: [],
  rage: 100,
  maximumRage: 100,
  queuedAbility: null,
  cooldownEndsAt: {},
  serverTime: Date.now(),
  revision: 1
} satisfies ClassSnapshot;

const readyEquipment = {
  playerId: "p",
  instances: [],
  weapon: null,
  chest: null,
  totalAttackPowerBonus: 0,
  totalDefenseBonus: 0
} satisfies EquipmentSnapshot;

function combatWithSession(overrides: Record<string, number> = {}): CombatEntitySnapshot {
  return {
    ...persistentProps.combat,
    classCombat: {
      ...persistentProps.combat.classCombat,
      resource: {
        resourceId: "rage",
        displayName: "Rage",
        current: 100,
        maximum: 100,
        reserved: 0
      },
      rage: 100,
      cooldownEndsAt: overrides
    },
    pveCombat: {
      sessionId: "session-1",
      focusTargetEntityId: "mob:1",
      enemyQueue: ["mob:1"],
      pursuingEnemyIds: [],
      queueCursor: 0,
      phase: "waiting_player",
      nextBasicAttackAt: null,
      resetWindowEndsAt: null,
      pendingNormalAbilityId: null,
      pendingResetAbilityId: null,
      tauntCooldownEndsAt: 0,
      activeViewCenter: { lat: 35, lon: -106 },
      activeViewRadiusM: 950,
      activeViewGeneration: 1,
      lastTauntExcludedByCap: 0
    }
  };
}

describe("PhoneHud", () => {
  it("renders the bottom dock only for ready gameplay, including gameplay overlays", () => {
    const view = render(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      gameplayReady={false}
      actions={[]}
    />);
    expect(document.body.querySelector(".phone-bottom-bar")).toBeNull();

    view.rerender(<PhoneHud {...persistentProps} menuView="menu" gameplayReady actions={[]} />);
    expect(document.body.querySelector(".phone-bottom-bar")).toBeNull();

    view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" gameplayReady actions={[]} />);
    expect(document.body.querySelector(".phone-bottom-bar")).not.toBeNull();

    view.rerender(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      actions={[]}
      hideBottomDock
    />);
    expect(document.body.querySelector(".phone-bottom-bar")).toBeNull();

    view.rerender(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      gameplayReady
      actions={[]}
      abilityTargetSelection={{ mode: "self", targetEntityId: "p" }}
    />);
    expect(document.body.querySelector(".phone-bottom-bar")).not.toBeNull();
  });

  it("does not mount combat skill controls or a floating Heal on the phone HUD", () => {
    const onUseSkillSystemV3Technique = vi.fn();
    const v3Snapshot = {
      playerId: "p", characterLevel: 25,
      pointState: { totalEarned: 50, totalSpent: 20, available: 30, revision: 4 },
      generalSkills: [{ skillId: "shield_charge", rank: 1, pointsSpent: 1 }],
      specializations: [{ specializationId: "warrior", rank: 5, pointsSpent: 8, grandfathered: false, masteryQuestCompleted: true }],
      committedSpecializationId: "warrior",
      activeSpecializationId: "warrior",
      equippedClassTechniqueId: null,
      fullBuildRespecAvailable: false,
      fullClassRosterEnabled: true,
      ultimatesEnabled: false,
      generalActiveLoadout: ["shield_charge", null],
      ultimate: { id: "warrior_v3_worldbreaker", specializationId: "warrior", status: "ready" },
      cooldownEndsAt: {}, worldKnowledge: [], serverTime: 1, revision: 4
    } satisfies SkillSystemV3Snapshot;
    const view = render(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      actions={[]}
      classSnapshot={readyClassSnapshot}
      equipment={readyEquipment}
      skillSystemV3Snapshot={v3Snapshot}
      onUseSkillSystemV3Technique={onUseSkillSystemV3Technique}
    />);

    expect(view.container.querySelector('[data-skill-system-version="v3"]')).toBeNull();
    expect(view.container.querySelector(".phone-combat-controls")).toBeNull();
    expect(view.container.querySelectorAll(".skill-v3-general-slot")).toHaveLength(0);
    expect(document.body.querySelectorAll(".legacy-control-button.legacy-skill-button")).toHaveLength(0);
    expect(document.body.querySelector(".legacy-heal-button")).toBeNull();
    expect(view.container.textContent).not.toMatch(/Ultimate|Worldbreaker|Mastery/i);
    expect(onUseSkillSystemV3Technique).not.toHaveBeenCalled();

    view.rerender(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      actions={[]}
      classSnapshot={readyClassSnapshot}
      equipment={readyEquipment}
      skillSystemV3Snapshot={null}
    />);
    expect(view.container.querySelector('[data-skill-system-version="v3"]')).toBeNull();
    expect(view.container.querySelectorAll(".legacy-skill-button")).toHaveLength(0);
    expect(view.container.textContent).not.toMatch(/Ultimate|Worldbreaker|Mastery/i);
  });

  it("shows or hides quick slots by holding the dock's bag, while a tap still opens Inventory", () => {
    vi.useFakeTimers();
    const onToggleHotbar = vi.fn();
    const onOpenDestination = vi.fn();
    render(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      actions={[]}
      hotbarVisible
      onToggleHotbar={onToggleHotbar}
      onOpenDestination={onOpenDestination}
    />);

    expect(document.body.querySelector(".legacy-hotbar-toggle")).toBeNull();
    const bag = screen.getByRole("button", { name: /^Open Inventory/ });
    expect(bag.getAttribute("title")).toContain("Hold to show or hide quick slots");
    fireEvent.pointerDown(bag, { button: 0, isPrimary: true, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(bag, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.click(bag);
    expect(onToggleHotbar).toHaveBeenCalledOnce();
    expect(onOpenDestination).not.toHaveBeenCalled();

    fireEvent.pointerDown(bag, { button: 0, isPrimary: true, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(bag, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.click(bag);
    expect(onOpenDestination).toHaveBeenCalledWith("equipment");
    expect(onToggleHotbar).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("renders authoritative Bitter Blood progress instead of the achievement placeholder", () => {
    render(<PhoneHud
      {...persistentProps}
      menuView="achievements"
      actions={[]}
      achievements={{
        playerId: "p",
        achievements: [{
          achievementId: "bitter_blood",
          title: "Bitter Blood",
          badgeId: "bitter_blood",
          completed: false,
          completedAt: null,
          statKey: "poison_damage_taken",
          value: 184,
          requiredValue: 250
        }],
        serverTime: 1
      }}
    />);

    expect(screen.queryByRole("dialog", { name: "Achievements" })).toBeNull();
    expect(screen.queryByText("Poison damage taken: 184 / 250")).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "Bitter Blood progress" })).toBeNull();
    expect(screen.queryByText("Achievements are still being forged.")).toBeNull();
  });

  it("suppresses and inerts gameplay HUD beneath public chat and direct-message protection", () => {
    const view = render(
      <>
        <div className="map-root" data-testid="gameplay-map" />
        <PhoneHud {...persistentProps} menuView="gameplay" actions={[]} />
        <MobileChatOverlay open type="public" aria-label="Public chat">
          <form data-mobile-chat-composer><textarea aria-label="Public draft" /></form>
        </MobileChatOverlay>
      </>
    );
    let hud = view.container.querySelector<HTMLElement>(".phone-hud")!;
    expect(hud.dataset.chatSuppressed).toBe("true");
    expect(hud.getAttribute("aria-hidden")).toBe("true");
    expect(hud.hasAttribute("inert")).toBe(true);
    expect(document.body.querySelector(".legacy-controls-right")).toBeNull();
    expect(document.documentElement.dataset.mobileChatProtected).toBe("true");
    expect(view.container.querySelector('[data-mobile-chat-protection="public"]')).toBeTruthy();
    expect(view.container.querySelector(".map-root")).toBeTruthy();

    view.rerender(
      <>
        <div className="map-root" data-testid="gameplay-map" />
        <PhoneHud {...persistentProps} menuView="gameplay" actions={[]} />
        <MobileChatOverlay open type="direct" aria-label="Direct messages">
          <form data-mobile-chat-composer><textarea aria-label="DM draft" /></form>
        </MobileChatOverlay>
      </>
    );
    hud = view.container.querySelector<HTMLElement>(".phone-hud")!;
    expect(hud.dataset.chatSuppressed).toBe("true");
    expect(hud.hasAttribute("inert")).toBe(true);
    expect(view.container.querySelector('[data-mobile-chat-protection="direct"]')).toBeTruthy();

    view.rerender(
      <>
        <div className="map-root" data-testid="gameplay-map" />
        <PhoneHud {...persistentProps} menuView="gameplay" actions={[]} />
      </>
    );
    hud = view.container.querySelector<HTMLElement>(".phone-hud")!;
    expect(hud.dataset.chatSuppressed).toBe("false");
    expect(hud.getAttribute("aria-hidden")).toBe("false");
    expect(hud.hasAttribute("inert")).toBe(false);
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
  });

  it("requests the controlled Game Menu from the compact center button", () => {
    const onOpenMenu = vi.fn();
    render(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} onOpenMenu={onOpenMenu} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open Game Menu/ }));
    expect(onOpenMenu).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Game Menu" })).toBeNull();
  });

  it("renders the Game Menu sheet as three ruled sections of four direct apps", () => {
    const onOpenDestination = vi.fn();
    const onOpenCategory = vi.fn();
    const view = render(<PhoneHud
      {...persistentProps}
      menuView="menu"
      actions={[]}
      onOpenCategory={onOpenCategory}
      onOpenDestination={onOpenDestination}
    />);
    const menu = screen.getByRole("dialog", { name: "Game Menu" });
    expect(menu.querySelectorAll(".phone-menu-primary-grid .phone-menu-item")).toHaveLength(12);
    expect(Array.from(menu.querySelectorAll(".phone-menu-sheet-heading"), (heading) => heading.textContent)).toEqual([
      "Adventurer", "Fellowship", "Realm"
    ]);
    expect(Array.from(menu.querySelectorAll<HTMLElement>(".phone-menu-root [data-mobile-menu-id]"), ({ dataset }) => dataset.mobileMenuId)).toEqual([
      "equipment", "classes", "pet-chamber", "creature-book",
      "messages", "contacts", "party", "leaderboards",
      "world-map", "crafting", "build", "flags"
    ]);
    expect(menu.querySelectorAll('[data-mobile-menu-kind="group"]')).toHaveLength(0);
    const rootGlyph = (selector: string) => menu.querySelector(`${selector} svg`)?.innerHTML ?? "";
    // Every tile carries its own duotone glyph: an ink shape plus a tint layer.
    const glyphs = Array.from(menu.querySelectorAll(".phone-menu-sheet-row svg.menu-destination-glyph"));
    expect(glyphs).toHaveLength(12);
    expect(new Set(glyphs.map((glyph) => glyph.innerHTML)).size).toBe(12);
    expect(rootGlyph('[data-mobile-menu-id="equipment"]')).toContain('opacity="0.2"');
    expect(screen.getByRole("button", { name: "Notice Board" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings & Support" })).toBeTruthy();
    expect(menu.querySelector(".phone-menu-root-footer")?.textContent).toBe("Return to Game");
    for (const [label, id] of [["Progression", "classes"], ["Rankings", "leaderboards"], ["Atlas", "world-map"],
      ["Crafting", "crafting"], ["Construction", "build"], ["Land", "flags"], ["Contacts", "contacts"], ["Inventory", "equipment"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onOpenDestination).toHaveBeenLastCalledWith(id);
    }
    expect(onOpenCategory).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-mobile-menu-kind="category"]')).toBeNull();
  });

  it("keeps root utilities in the header and makes Return to Game the sole footer target", () => {
    const onBack = vi.fn();
    const onOpenDestination = vi.fn();
    render(<PhoneHud
      {...persistentProps}
      menuView="menu"
      actions={[]}
      onBack={onBack}
      onOpenDestination={onOpenDestination}
    />);

    const menu = screen.getByRole("dialog", { name: "Game Menu" });
    const headerActions = menu.querySelector<HTMLElement>(".phone-menu-header-actions")!;
    const headerChildren = Array.from(headerActions.children);
    expect(headerChildren[0]?.classList.contains("phone-menu-world-time")).toBe(true);
    expect(headerActions.querySelectorAll("button")).toHaveLength(2);
    const notice = screen.getByRole("button", { name: "Notice Board" });
    const settings = screen.getByRole("button", { name: "Settings & Support" });
    expect(notice.getAttribute("title")).toBe("Notice Board");
    expect(settings.getAttribute("title")).toBe("Settings & Support");
    expect(notice.querySelector("svg")).toBeTruthy();
    expect(settings.querySelector("svg")).toBeTruthy();
    expect(menu.querySelectorAll(".phone-menu-root-footer button")).toHaveLength(1);
    const footer = menu.querySelector<HTMLElement>(".phone-menu-root-footer")!;
    expect(footer.getAttribute("aria-label")).toBe("Return to Game");
    expect(footer.querySelector(".phone-menu-notice-board")).toBeNull();
    expect(footer.querySelector(".phone-menu-utility")).toBeNull();

    fireEvent.click(settings);
    fireEvent.click(screen.getByRole("button", { name: "Return to Game" }));
    expect(onOpenDestination).toHaveBeenCalledWith("miscellaneous");
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("uses the live profile summary as the direct Profile root entry", () => {
    // The desktop card uses the same profile route, which selects Loadout in App.
    const desktopOpen = vi.fn();
    const desktop = render(<PhoneHud {...persistentProps} menuView="gameplay" presentation="desktop" player={{ username: "Wren", displayColor: null }} actions={[]} onOpenDestination={desktopOpen} />);
    expect(screen.queryByRole("button", { name: /^Open Game Menu/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Inventory" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Game commands" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Loadout for Wren" }));
    expect(desktopOpen).toHaveBeenCalledWith("profile");
    desktop.unmount();
    const onOpenDestination = vi.fn();
    const view = render(<PhoneHud
      {...persistentProps}
      player={{ username: "Wren", displayColor: null, classId: "ronin" }}
      menuView="menu"
      actions={[]}
      onOpenDestination={onOpenDestination}
    />);
    const profile = screen.getByRole("button", { name: /^Open Loadout for Wren/ });
    const root = view.container.querySelector<HTMLElement>(".phone-menu-root");
    expect(root).toBeTruthy();
    expect(profile.compareDocumentPosition(root as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(profile.textContent).toContain("Wren");
    // The active class (PlayerSnapshot.classId), never the legacy class profile.
    expect(profile.querySelector(".phone-menu-profile-class")?.textContent).toMatch(/^Ronin · Level \d+$/);
    expect(profile.textContent).toContain("397 / 800");
    expect(profile.getAttribute("data-mobile-menu-id")).toBe("profile");
    expect(profile.getAttribute("data-mobile-menu-kind")).toBe("destination");
    expect(profile.getAttribute("aria-label")).toContain("Lifetime kill death ratio is not tracked yet");

    fireEvent.click(profile);
    expect(onOpenDestination).toHaveBeenCalledWith("profile");
  });

  it("asks for a Menu-hold shortcut on the first hold, then opens it directly", () => {
    vi.useFakeTimers();
    localStorage.removeItem("ash-atlas:menu-hold-shortcut:v1:player-hold");
    const onOpenMenu = vi.fn();
    const onOpenDestination = vi.fn();
    const props = { ...persistentProps, menuView: "gameplay" as const, actions: [], playerId: "player-hold", onOpenMenu, onOpenDestination };
    const view = render(<PhoneHud {...props} />);
    const hold = () => {
      const menu = screen.getByRole("button", { name: /^Open Game Menu/ });
      fireEvent.pointerDown(menu, { button: 0, isPrimary: true, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(500); });
      fireEvent.pointerUp(menu, { button: 0, isPrimary: true, pointerId: 1 });
      fireEvent.click(menu);
    };

    hold();
    expect(onOpenMenu).not.toHaveBeenCalled();
    expect(screen.getByText("Pick your Menu shortcut")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Crafting" }));
    expect(onOpenDestination).toHaveBeenLastCalledWith("crafting");
    expect(localStorage.getItem("ash-atlas:menu-hold-shortcut:v1:player-hold")).toBe("crafting");

    view.unmount();
    onOpenDestination.mockClear();
    render(<PhoneHud {...props} />);
    expect(screen.getByRole("button", { name: "Open Game Menu; hold for Crafting" })).toBeTruthy();
    hold();
    expect(screen.queryByText("Pick your Menu shortcut")).toBeNull();
    expect(onOpenDestination).toHaveBeenCalledWith("crafting");
    localStorage.removeItem("ash-atlas:menu-hold-shortcut:v1:player-hold");
    vi.useRealTimers();
  });

  it("keeps Menu as the single center trigger and Inventory on the economy readout", () => {
    const onOpenMenu = vi.fn();
    const onOpenDestination = vi.fn();
    render(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      actions={[]}
      onOpenMenu={onOpenMenu}
      onOpenDestination={onOpenDestination}
    />);

    const footer = screen.getByRole("contentinfo", { name: "Phone bottom HUD" });
    expect(footer.querySelector(".phone-field-rail-heading")).toBeNull();
    expect(footer.querySelectorAll(".phone-menu-trigger")).toHaveLength(1);
    expect(footer.querySelector(".phone-menu-trigger")?.textContent).toBe("Menu");
    expect(footer.querySelector(".phone-inventory-trigger")).toBeNull();
    const inventory = footer.querySelector(".phone-bottom-economy")!;

    fireEvent.click(inventory);
    expect(onOpenDestination).toHaveBeenCalledOnce();
    expect(onOpenDestination).toHaveBeenCalledWith("equipment");
    fireEvent.click(screen.getByRole("button", { name: /^Open Game Menu/ }));
    expect(onOpenMenu).toHaveBeenCalledOnce();
  });

  it("shows a persistent Afloat tag in the player-state slot at ease", () => {
    const view = render(<PhoneHud
      {...persistentProps}
      menuView="gameplay"
      actions={[]}
      afloat
    />);
    const state = document.querySelector(".phone-menu-state")!;
    expect(state.getAttribute("data-player-state")).toBe("afloat");
    expect(state.getAttribute("aria-label")).toBe("Afloat");
    expect(state.querySelector(".phone-menu-state-tag")?.textContent).toBe("Afloat");
    expect(state.querySelector(".phone-menu-state-ring")).toBeNull();
    view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} />);
    expect(document.querySelector(".phone-menu-state")?.getAttribute("data-player-state")).toBe("none");
  });

  it("renders the Adventurer Hunger row with responsive value states", () => {
    const view = render(<PhoneHud
      {...persistentProps}
      player={{ username: "Wren", displayColor: null }}
      hunger={{ current: 2_000, baseCapacity: 2_000 }}
      menuView="menu"
      actions={[]}
    />);
    const profile = view.container.querySelector<HTMLElement>(".phone-menu-profile");
    expect(profile).toBeTruthy();
    expect(profile?.textContent).toContain("Hunger2,000 / 2,000");
    expect(profile?.querySelector(".phone-menu-profile-hunger")?.getAttribute("data-hunger-state")).toBe("full");
    expect(profile?.querySelector<HTMLElement>(".phone-menu-profile-hunger-track i")?.style.width).toBe("100%");

    view.rerender(<PhoneHud
      {...persistentProps}
      player={{ username: "Wren", displayColor: null }}
      hunger={{ current: 1_000, baseCapacity: 2_000 }}
      menuView="menu"
      actions={[]}
    />);
    expect(profile?.querySelector(".phone-menu-profile-hunger")?.getAttribute("data-hunger-state")).toBe("half");
    expect(profile?.querySelector<HTMLElement>(".phone-menu-profile-hunger-track i")?.style.width).toBe("50%");

    view.rerender(<PhoneHud
      {...persistentProps}
      player={{ username: "Wren", displayColor: null }}
      hunger={{ current: 100, baseCapacity: 2_000 }}
      menuView="menu"
      actions={[]}
    />);
    expect(profile?.querySelector(".phone-menu-profile-hunger")?.getAttribute("data-hunger-state")).toBe("small");

    view.rerender(<PhoneHud
      {...persistentProps}
      player={{ username: "Wren", displayColor: null }}
      hunger={{ current: 0, baseCapacity: 2_000 }}
      menuView="menu"
      actions={[]}
    />);
    expect(profile?.querySelector(".phone-menu-profile-hunger")?.getAttribute("data-hunger-state")).toBe("empty");
  });

  it("offers Reset window positions and no Menu-hold setting on desktop only", () => {
    const view = render(<PhoneHud {...persistentProps} presentation="desktop" menuView="miscellaneous" actions={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset window positions" }));
    expect(screen.getByText(/back in their default places/)).toBeTruthy();
    expect(screen.queryByText("Menu hold shortcut")).toBeNull();
    view.rerender(<PhoneHud {...persistentProps} presentation="touch" menuView="miscellaneous" actions={[]} />);
    expect(screen.queryByRole("button", { name: "Reset window positions" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Utility Hotbar" }));
    expect(screen.getByText("Menu hold shortcut")).toBeTruthy();
  });

  it("keeps Settings & Support in the root header and gates Report a Bug by capability", () => {
    const onOpenBugReport = vi.fn();
    const view = render(<PhoneHud {...persistentProps} destinations={destinations} menuView="menu" actions={[]} onOpenBugReport={onOpenBugReport} />);
    expect(screen.getByRole("button", { name: "Settings & Support" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings & Support" }));
    view.rerender(<PhoneHud {...persistentProps} destinations={destinations} menuView="miscellaneous" actions={[]} onOpenBugReport={onOpenBugReport} bugReportsEnabled />);
    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    fireEvent.click(screen.getByRole("tab", { name: "Delete Account" }));
    expect(screen.getByRole("link", { name: "Delete Account" }).getAttribute("href"))
      .toBe("https://playashatlas.com/delete-account");
    fireEvent.click(screen.getByRole("tab", { name: "Support" }));
    fireEvent.click(screen.getByRole("button", { name: "Report a Bug" }));
    expect(onOpenBugReport).toHaveBeenCalledOnce();

    view.rerender(<PhoneHud {...persistentProps} destinations={destinations} menuView="miscellaneous" actions={[]} onOpenBugReport={onOpenBugReport} />);
    expect(screen.queryByRole("button", { name: "Report a Bug" })).toBeNull();
  });

  it("keeps Notice Board unified in the header and rolls up patch-note status", () => {
    const onOpenDestination = vi.fn();
    const withPatchNotes = destinations.map((destination) => destination.id === "patch-notes"
      ? { ...destination, badge: "99+", badgeCount: 137, badgeAccessibleLabel: "137 unread patch notes" }
      : destination);
    render(<PhoneHud
      {...persistentProps}
      destinations={withPatchNotes}
      menuView="menu"
      actions={[]}
      onOpenDestination={onOpenDestination}
    />);
    expect(screen.queryByRole("navigation", { name: "Notice Board destinations" })).toBeNull();
    const button = screen.getByRole("button", { name: "Notice Board, 137 unread patch notes" });
    expect(button.closest(".phone-menu-header-actions")).not.toBeNull();
    expect(button.closest(".phone-menu-root-footer")).toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.querySelector(".phone-menu-unread-badge")?.textContent).toBe("99+");
    fireEvent.click(button);
    expect(onOpenDestination).toHaveBeenCalledWith("announcements");
  });

  it("keeps the shallow root inert beneath Messages", () => {
    const view = render(
      <PhoneHud {...persistentProps} menuView="messages" actions={[]} />
    );
    const hud = view.container.querySelector<HTMLElement>(".phone-hud")!;
    let underlay = view.container.querySelector<HTMLElement>(".phone-menu-layer-underlay")!;
    expect(hud.classList.contains("phone-hud-menu-underlay")).toBe(true);
    expect(hud.getAttribute("aria-hidden")).toBe("true");
    expect(hud.hasAttribute("inert")).toBe(true);
    expect(underlay).toBeTruthy();
    expect(underlay.hasAttribute("inert")).toBe(true);
    expect(underlay.getAttribute("aria-hidden")).toBe("true");
    expect(underlay.querySelector(".phone-menu-root")).toBeTruthy();
    expect(underlay.querySelector('.phone-menu-primary-grid')).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Game Menu" })).toBeNull();

    view.rerender(<PhoneHud {...persistentProps} menuView="messages" menuCategory="social" actions={[]} />);
    underlay = view.container.querySelector<HTMLElement>(".phone-menu-layer-underlay")!;
    expect(underlay.querySelector('.phone-menu-primary-grid')).toBeTruthy();
    expect(underlay.querySelector(".phone-menu-root")).toBeTruthy();
  });

  it("caps the visual Messages badge while preserving the exact accessible count and hides zero", () => {
    const withLargeCount = destinations.map((destination) =>
      destination.id === "messages"
        ? { ...destination, badge: "99+", badgeCount: 137 }
        : destination
    );
    const view = render(
      <PhoneHud {...persistentProps} destinations={withLargeCount} menuView="menu" actions={[]} />
    );
    view.rerender(<PhoneHud {...persistentProps} destinations={withLargeCount} menuView="menu" menuCategory="social" actions={[]} />);
    const messages = screen.getByRole("button", { name: "Messages, 137 unread messages" });
    const badge = messages.querySelector(".phone-menu-unread-badge");
    expect(badge?.textContent).toBe("99+");
    expect(badge?.parentElement?.classList.contains("phone-menu-label")).toBe(true);
    expect(badge?.getAttribute("aria-hidden")).toBe("true");

    const withoutCount = destinations.map((destination) =>
      destination.id === "messages"
        ? { id: "messages" as const }
        : destination
    );
    view.rerender(
      <PhoneHud {...persistentProps} destinations={withoutCount} menuView="menu" menuCategory="social" actions={[]} />
    );
    expect(screen.getByRole("button", { name: "Messages" }).querySelector(".phone-menu-unread-badge")).toBeNull();
  });

  it("keeps numeric destination counts on direct app tiles", () => {
    const withStatuses = destinations.map((destination) => {
      if (destination.id === "messages") return { ...destination, badge: "3", badgeCount: 3 };
      if (destination.id === "party") return { ...destination, badge: "2", badgeCount: 2 };
      return destination;
    });
    render(<PhoneHud {...persistentProps} destinations={withStatuses} menuView="menu" actions={[]} />);

    const messages = screen.getByRole("button", { name: "Messages, 3 unread messages" });
    const party = screen.getByRole("button", { name: "Party, 2 pending party invites" });
    expect(messages.querySelector(".phone-menu-unread-badge")?.textContent).toBe("3");
    expect(party.querySelector(".phone-menu-unread-badge")?.textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Progression" }).querySelector(".phone-menu-unread-badge")).toBeNull();
  });

  it("announces destination-specific badge status and disabled reasons", () => {
    const withStatuses = destinations.map((destination) => {
      if (destination.id === "messages") {
        return {
          ...destination,
          badge: "99+",
          badgeCount: 137,
          badgeAccessibleLabel: "137 unread messages"
        };
      }
      if (destination.id === "party") {
        return {
          ...destination,
          badge: "2",
          badgeCount: 2,
          badgeAccessibleLabel: "2 pending party invites"
        };
      }
      return destination.id === "world-map"
        ? { ...destination, disabledReason: "Exit the interior to open the World Map." }
        : destination;
    });
    const view = render(<PhoneHud {...persistentProps} destinations={withStatuses} menuView="menu" actions={[]} />);

    expect(screen.getByRole("button", { name: "Messages, 137 unread messages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Party, 2 pending party invites" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Party, 2 pending party invites" }).getAttribute("aria-label")).not.toContain("unread");
    view.rerender(<PhoneHud {...persistentProps} destinations={withStatuses} menuView="menu" actions={[]} />);
    const worldMap = screen.getByRole("button", { name: "Atlas, Exit the interior to open the World Map." });
    expect(worldMap.hasAttribute("disabled")).toBe(true);
    expect(worldMap.getAttribute("title")).toBe("Exit the interior to open the World Map.");
  });

  it("exposes the shared Light and Dark appearance setting", () => {
    const onMenuThemeChange = vi.fn();
    render(<PhoneHud {...persistentProps} menuView="miscellaneous" actions={[]} menuTheme="light" onMenuThemeChange={onMenuThemeChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    const select = screen.getByRole("combobox", { name: "Menu theme" });
    expect((select as HTMLSelectElement).value).toBe("light");
    fireEvent.change(select, { target: { value: "dark" } });
    expect(onMenuThemeChange).toHaveBeenCalledWith("dark");
  });

  it("opens Settings & Support in the shared shell with complete map credits and Return to Game", () => {
    const returned = vi.fn();
    window.addEventListener("ashAtlasMobileMenuReturnToGame", returned, { once: true });
    render(<PhoneHud {...persistentProps} menuView="miscellaneous" actions={[]} />);
    expect(screen.getByRole("dialog", { name: "Settings & Support" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Utility Hotbar" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Settings sections" }).classList.contains("game-app-tabs-housed")).toBe(true);
    expect(screen.getByRole("tablist", { name: "Gameplay settings" }).classList.contains("game-app-tabs-subtabs")).toBe(true);
    expect(screen.queryByRole("heading", { name: "Layout" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Layout" })).toBeNull();
    expect(screen.queryByText(/Automatic currently selects/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Map" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "UI Layout" })).toBeNull();
    expect(screen.queryByText("Utility Ledger")).toBeNull();
    expect(screen.queryByText("Display, map settings, help, credits, and account controls.")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    fireEvent.click(screen.getByRole("tab", { name: "Credits" }));
    expect(screen.getByRole("heading", { name: "Map & Data Credits" })).toBeTruthy();
    const osm = screen.getByRole("link", { name: /OpenStreetMap copyright/ });
    expect(osm.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(osm.getAttribute("rel")).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: "Return to Game" }));
    expect(returned).toHaveBeenCalledOnce();
  });

  it("keeps the native Visible rows picker closed until the player taps it", () => {
    render(
      <PhoneHud
        {...persistentProps}
        menuView="miscellaneous"
        actions={[]}
        hotbarRowCount={4}
        hotbarRowPositions={[0, 21, 42, 63, 84]}
        onHotbarLayoutChange={vi.fn()}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Settings & Support" });
    const visibleRows = screen.getByRole("combobox", { name: "Visible rows" });
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(visibleRows);
  });

  it("shows the zoom toggle in mobile Miscellaneous only for authorized developers", () => {
    const onZoomIndicatorChange = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="miscellaneous"
        actions={[]}
        onZoomIndicatorChange={onZoomIndicatorChange}
      />
    );
    expect(screen.queryByRole("heading", { name: "Diagnostics" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Show Zoom Level/ })).toBeNull();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        developerAccessEnabled
        zoomIndicatorEnabled
        menuView="miscellaneous"
        actions={[]}
        onZoomIndicatorChange={onZoomIndicatorChange}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Support" }));
    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Developer App" })).toBeNull();
    const toggle = screen.getByRole("checkbox", { name: /Show Zoom Level/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onZoomIndicatorChange).toHaveBeenCalledWith(false);
  });

  it("edits and resets the mobile default zoom in Map", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        mobileDefaultZoom={14.75}
        menuView="miscellaneous"
        actions={[]}
        onMobileDefaultZoomChange={onChange}
        onResetMobileDefaultZoom={onReset}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    expect(screen.getByRole("heading", { name: "Map" })).toBeTruthy();
    expect(screen.getByText("14.75")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Default zoom" }), {
      target: { value: "16.25" }
    });
    expect(onChange).toHaveBeenCalledWith(16.25);
    fireEvent.click(screen.getByRole("button", { name: "Reset to 15" }));
    expect(onReset).toHaveBeenCalledOnce();

    view.rerender(
      <PhoneHud {...persistentProps} menuView="miscellaneous" actions={[]} />
    );
    expect((screen.getByRole("button", { name: "Reset to 15" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the tap assistance presets and reports changes", () => {
    const onChange = vi.fn();
    render(
      <PhoneHud
        {...persistentProps}
        tapAssistancePreference="precise"
        menuView="miscellaneous"
        actions={[]}
        onTapAssistancePreferenceChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    const selector = screen.getByRole("combobox", { name: "Tap assistance" });
    expect((selector as HTMLSelectElement).value).toBe("precise");
    expect(Array.from((selector as HTMLSelectElement).options).map(({ text }) => text)).toEqual([
      "Precise",
      "Standard",
      "Large"
    ]);
    expect(screen.getByText(/may show Choose Target more often/)).toBeTruthy();

    fireEvent.change(selector, { target: { value: "large" } });
    expect(onChange).toHaveBeenCalledWith("large");
  });

  it("keeps the automatic layout choice internal to Settings & Support", () => {
    render(<PhoneHud {...persistentProps} menuView="miscellaneous" actions={[]} />);
    expect(screen.getByRole("heading", { name: "Utility Hotbar" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Layout" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Layout" })).toBeNull();
    expect(screen.queryByText(/Automatic currently selects/)).toBeNull();
    expect(screen.queryByText(/viewport is too small/)).toBeNull();
  });

  it("keeps only the visible-row selector and live Adjust Slots action", () => {
    const onHotbarLayoutChange = vi.fn();
    const onOpenHotbarLayoutEditor = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="miscellaneous"
        actions={[]}
        hotbarRowCount={4}
        hotbarRowPositions={[0, 21, 42, 63, 84]}
        onHotbarLayoutChange={onHotbarLayoutChange}
        onOpenHotbarLayoutEditor={onOpenHotbarLayoutEditor}
      />
    );

    const visibleRows = screen.getByRole("combobox", { name: "Visible rows" });
    expect(Array.from((visibleRows as HTMLSelectElement).options).map(({ text }) => text)).toEqual([
      "Off", "1 row", "2 rows", "3 rows", "4 rows", "5 rows"
    ]);
    expect(screen.queryByRole("slider", { name: /Row .* position from top/ })).toBeNull();
    expect(screen.queryByText(/preview/i)).toBeNull();
    fireEvent.change(visibleRows, { target: { value: "5" } });
    expect(onHotbarLayoutChange).toHaveBeenCalledWith(5, [0, 21, 42, 63, 84]);
    fireEvent.click(screen.getByRole("button", { name: "Adjust Slots" }));
    expect(onOpenHotbarLayoutEditor).toHaveBeenCalledOnce();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="miscellaneous"
        actions={[]}
        hotbarRowCount={0}
        hotbarRowPositions={[0, 21, 42, 63, 84]}
        onHotbarLayoutChange={onHotbarLayoutChange}
        onOpenHotbarLayoutEditor={onOpenHotbarLayoutEditor}
      />
    );
    expect(screen.queryByRole("button", { name: "Adjust Slots" })).toBeNull();
  });

  it("updates the visible-row setting immediately and keeps the latest save response", async () => {
    const saves: Array<{
      rowPositions: number[];
      resolve(positions: readonly number[]): void;
    }> = [];
    const save = vi.fn((_rowCount: number, rowPositions: readonly number[]) =>
      new Promise<readonly number[]>((resolve) => {
        saves.push({ rowPositions: [...rowPositions], resolve });
      })
    );
    render(<ControlledHotbarSettings save={save} />);

    const visibleRows = screen.getByRole("combobox", { name: "Visible rows" });
    fireEvent.change(visibleRows, { target: { value: "3" } });
    fireEvent.change(visibleRows, { target: { value: "5" } });
    expect(save).toHaveBeenCalledTimes(2);
    expect(saves.map(({ rowPositions }) => rowPositions)).toEqual([
      [0, 21, 42, 63, 84],
      [0, 21, 42, 63, 84]
    ]);

    await act(async () => {
      saves[0]!.resolve(saves[0]!.rowPositions);
      await Promise.resolve();
    });
    expect((screen.getByRole("combobox", { name: "Visible rows" }) as HTMLSelectElement).value).toBe("5");
    await act(async () => {
      saves[1]!.resolve(saves[1]!.rowPositions);
      await Promise.resolve();
    });
    expect((screen.getByRole("combobox", { name: "Visible rows" }) as HTMLSelectElement).value).toBe("5");
  });

  it("removes the misleading miniature preview and exposes the live editor entry point", () => {
    const onOpenHotbarLayoutEditor = vi.fn();
    render(
      <PhoneHud
        {...persistentProps}
        menuView="miscellaneous"
        actions={[]}
        hotbarRowCount={4}
        hotbarRowPositions={[0, 52, 64, 76, 84]}
        onOpenHotbarLayoutEditor={onOpenHotbarLayoutEditor}
      />
    );

    expect(screen.queryByRole("img", { name: /Utility hotbar preview/ })).toBeNull();
    expect(screen.queryByRole("slider", { name: /Row .* position from top/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Adjust Slots" }));
    expect(onOpenHotbarLayoutEditor).toHaveBeenCalledOnce();
  });

  it("uses the same live editor entry point in wide settings", () => {
    const onOpenHotbarLayoutEditor = vi.fn();
    render(
      <PhoneHud
        {...persistentProps}
        effectiveLayoutMode="wide"
        menuView="miscellaneous"
        actions={[]}
        hotbarRowCount={5}
        hotbarRowPositions={[0, 21, 42, 63, 84]}
        onOpenHotbarLayoutEditor={onOpenHotbarLayoutEditor}
      />
    );

    expect(screen.queryByRole("img", { name: /Utility hotbar preview/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Adjust Slots" }));
    expect(onOpenHotbarLayoutEditor).toHaveBeenCalledOnce();
  });

  it("ignores the click from lifting a held finger, even over whatever the hold opened", () => {
    vi.useFakeTimers();
    const onOpenWorldMap = vi.fn();
    const onOpenDestination = vi.fn();
    render(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]}
      onOpenWorldMap={onOpenWorldMap} onOpenDestination={onOpenDestination} />);
    const vitals = screen.getByRole("button", { name: /^Player resources/ });
    const bag = screen.getByRole("button", { name: /^Open Inventory/ });
    fireEvent.pointerDown(vitals, { button: 0, isPrimary: true, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(299); });
    expect(onOpenWorldMap).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onOpenWorldMap).toHaveBeenCalledOnce();
    // Until the finger lifts, nothing may react or look pressed under it.
    expect(document.documentElement.dataset.dockHoldActive).toBe("true");
    // The finger lifts over a different control (in the app: the menu's Back).
    fireEvent.pointerUp(bag, { pointerId: 1 });
    // Still shielded through the tap the phone synthesizes after lifting.
    expect(document.documentElement.dataset.dockHoldActive).toBe("true");
    fireEvent.click(bag);
    expect(onOpenDestination).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.dockHoldActive).toBeUndefined();
    // The next real tap works normally.
    fireEvent.click(bag);
    expect(onOpenDestination).toHaveBeenCalledWith("equipment");
  });

  it("recenters on a quick locate tap and opens World Map only after a 500 ms hold", () => {
    vi.useFakeTimers();
    const onRecenter = vi.fn();
    const onOpenWorldMap = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        onRecenter={onRecenter}
        onOpenWorldMap={onOpenWorldMap}
      />
    );
    const locate = screen.getByRole("button", {
      name: "Player resources. Tap to center the map on you; hold for the World Map"
    });
    fireEvent.pointerDown(locate, { button: 0, isPrimary: true, pointerId: 1 });
    fireEvent.pointerUp(locate, { pointerId: 1 });
    fireEvent.click(locate);
    expect(onRecenter).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(500); });
    expect(onOpenWorldMap).not.toHaveBeenCalled();

    fireEvent.pointerDown(locate, { button: 0, isPrimary: true, pointerId: 2 });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(locate, { pointerId: 2 });
    fireEvent.click(locate);
    expect(onOpenWorldMap).toHaveBeenCalledOnce();
    expect(onRecenter).toHaveBeenCalledOnce();

    // A touch "leave" (the node under the finger re-rendered) keeps the hold;
    // a real slide away cancels it.
    // jsdom has no PointerEvent, so build pointer-shaped mouse events that keep coordinates.
    const touch = (type: string, pointerId: number, clientX: number, clientY: number) =>
      locate.dispatchEvent(Object.assign(
        new MouseEvent(type, { bubbles: type !== "pointerleave", clientX, clientY, button: 0 }),
        { pointerType: "touch", pointerId, isPrimary: true }
      ));
    touch("pointerdown", 3, 20, 20);
    touch("pointerleave", 3, 20, 20);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onOpenWorldMap).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(locate, { pointerId: 3 });
    fireEvent.click(locate);
    expect(onRecenter).toHaveBeenCalledOnce();

    touch("pointerdown", 4, 20, 20);
    touch("pointermove", 4, 20, 60);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onOpenWorldMap).toHaveBeenCalledTimes(2);

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="miscellaneous"
        actions={[]}
        onRecenter={onRecenter}
        onOpenWorldMap={onOpenWorldMap}
      />
    );
    expect(screen.queryByRole("checkbox", { name: /Legacy buttons/ })).toBeNull();
  });

  it("floats no build or heal button outside planning and keeps an exit while planning", () => {
    const onExitRulerMode = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        classSnapshot={readyClassSnapshot}
        combat={combatWithSession()}
        equipment={readyEquipment}
        onExitRulerMode={onExitRulerMode}
      />
    );
    expect(document.body.querySelector(".legacy-controls-left, .legacy-controls-right, .legacy-heal-button")).toBeNull();
    expect(screen.queryByRole("button", { name: /Place (flag|buoy)/ })).toBeNull();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        rulerMode
        onExitRulerMode={onExitRulerMode}
      />
    );
    const exit = screen.getByRole("button", { name: "Exit ruler mode" });
    expect(exit.querySelector('svg[data-legacy-icon="ruler"]')).toBeTruthy();
    fireEvent.click(exit);
    expect(onExitRulerMode).toHaveBeenCalledOnce();
  });

  it("shows the planning tool row only in ruler mode and confirms before clearing", () => {
    const onClearRuler = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        onClearRuler={onClearRuler}
      />
    );
    expect(document.body.querySelector(".legacy-controls-left")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Build from planning mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear all ruler measurements" })).toBeNull();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        rulerMode
        onClearRuler={onClearRuler}
      />
    );
    const planningControls = document.body.querySelector(".legacy-controls-left")!;
    expect(planningControls.classList.contains("planning-tools")).toBe(true);
    expect(Array.from(planningControls.children, (child) => child.getAttribute("aria-label"))).toEqual([
      "Open Build from planning mode",
      "Clear all ruler measurements",
      "Exit ruler mode"
    ]);
    expect(view.container.querySelector(".phone-ruler-hud")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear all ruler measurements" }));
    expect(screen.getByText("Clear measurements?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByText("RULER")).toBeNull();
    expect(screen.queryByText("Remove every ruler line and point from the map.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClearRuler).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear all ruler measurements" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClearRuler).toHaveBeenCalledOnce();
    expect(screen.queryByText("Clear measurements?")).toBeNull();
  });

  it("exposes Anchor Settings and the saved-anchor trash mode in planning", () => {
    const onOpenAnchorSettings = vi.fn();
    const onTogglePlanningTrash = vi.fn();
    render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        rulerMode
        onOpenAnchorSettings={onOpenAnchorSettings}
        onTogglePlanningTrash={onTogglePlanningTrash}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Anchor Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete saved planning anchor" }));
    expect(onOpenAnchorSettings).toHaveBeenCalledOnce();
    expect(onTogglePlanningTrash).toHaveBeenCalledOnce();
  });

  it("keeps builder actions in the original compact grid and removes quick-slot rails", () => {
    const onToggleMode = vi.fn();
    const onUndo = vi.fn();
    const onOpenLayers = vi.fn();
    const onClearLayer = vi.fn();
    const onExit = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        rulerMode
        planningBuilderSurfaceActive
        planningBuilderMode="anchor"
        planningCanUndo={false}
        planningUndoDisabledReason="Nothing to undo in this layer."
        onTogglePlanningBuilderMode={onToggleMode}
        onUndoPlanningAnchor={onUndo}
        onOpenPlanningLayers={onOpenLayers}
        onClearCurrentPlanningLayer={onClearLayer}
        onExitRulerMode={onExit}
      />
    );
    expect(view.container.querySelector(".phone-action-rail-left")).toBeNull();
    expect(view.container.querySelector(".phone-action-rail-right")).toBeNull();
    const controls = document.body.querySelector(".legacy-controls-left")!;
    expect(controls.classList.contains("planning-tools")).toBe(true);
    expect(Array.from(controls.children, (child) => child.getAttribute("aria-label"))).toEqual([
      "Switch to Select mode",
      "Pencil mode",
      "Tree planting mode",
      "Undo last anchor: Nothing to undo in this layer.",
      "Layers",
      "Clear Current Layer",
      "Exit builder mode"
    ]);
    expect((screen.getByRole("button", { name: /Undo last anchor:/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Switch to Select mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Current Layer" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit builder mode" }));
    expect(onToggleMode).toHaveBeenCalledOnce();
    expect(onOpenLayers).toHaveBeenCalledOnce();
    expect(onClearLayer).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        rulerMode
        planningBuilderSurfaceActive
        planningBuilderMode="select"
        planningCanUndo
        onTogglePlanningBuilderMode={onToggleMode}
        onUndoPlanningAnchor={onUndo}
        onOpenPlanningLayers={onOpenLayers}
        onClearCurrentPlanningLayer={onClearLayer}
        onExitRulerMode={onExit}
      />
    );
    expect(screen.getByRole("button", { name: "Switch to Anchor mode" }).querySelector('svg[data-legacy-icon="select"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo last anchor" }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("returns directly to gameplay from Build opened by planning and resets that source", () => {
    const onOpenDestination = vi.fn();
    const onReturnToGame = vi.fn();
    window.addEventListener(MOBILE_MENU_RETURN_EVENT, onReturnToGame);
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        rulerMode
        onOpenDestination={onOpenDestination}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Build from planning mode" }));
    expect(onOpenDestination).toHaveBeenCalledOnce();
    expect(onOpenDestination).toHaveBeenCalledWith("build");
    view.rerender(
      <PhoneHud {...persistentProps} menuView="build" actions={[]} onOpenDestination={onOpenDestination} />
    );
    expect(screen.queryByRole("button", { name: "Back to Game Menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Return to Game" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onReturnToGame).toHaveBeenCalledOnce();

    view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} />);
    view.rerender(<PhoneHud {...persistentProps} menuView="build" actions={[]} />);
    expect(screen.getByRole("button", { name: "Back to Game Menu" })).toBeTruthy();
    window.removeEventListener(MOBILE_MENU_RETURN_EVENT, onReturnToGame);
  });

  it("shows Sign out only inside authenticated Miscellaneous and invokes the existing handler once", () => {
    const onLogout = vi.fn();
    const view = render(<PhoneHud {...persistentProps} menuView="menu" actions={[]} onLogout={onLogout} />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();

    view.rerender(<PhoneHud {...persistentProps} menuView="miscellaneous" actions={[]} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
  });

  it("opens categorized Construction in phone and wide layouts", () => {
    const build = persistentProps.buildOptions[0]!.execute;
    const view = render(<PhoneHud {...persistentProps} menuView="build" actions={[]} />);
    const panel = screen.getByRole("dialog", { name: "Construction" });
    expect(screen.getByRole("tablist", { name: "Construction sections" }).classList.contains("game-app-tabs-housed")).toBe(true);
    expect(panel.querySelectorAll(".game-app-card")).toHaveLength(2);
    expect(panel.querySelectorAll(".game-app-card-leading > svg")).toHaveLength(2);
    expect(Array.from(panel.querySelectorAll(".game-app-card h3"), (node) => node.textContent))
      .toEqual(["Manor", "Territory Flag"]);
    expect(screen.queryByText("Personal Shrine", { exact: true })).toBeNull();
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe("true");
    const flagRequirements = screen.getByLabelText("Territory Flag requirements");
    const flagRequirementArtwork = Array.from(
      flagRequirements.querySelectorAll<HTMLImageElement>(
        ".phone-build-material-artwork"
      )
    );
    expect(flagRequirements.textContent).toBe("32");
    expect(flagRequirementArtwork).toHaveLength(2);
    expect(flagRequirementArtwork.map(({ src }) => src)).toEqual([
      expect.stringContaining("wood.png"),
      expect.stringContaining("leather.png")
    ]);
    expect(flagRequirements.textContent).not.toMatch(/wood|leather/i);
    fireEvent.click(screen.getByRole("tab", { name: "City" }));
    expect(Array.from(panel.querySelectorAll(".game-app-card h3"), (node) => node.textContent))
      .toEqual([
        "Barracks",
        "City",
        "City House",
        "City Market",
        "City Warehouse",
        "Demolition Factory",
        "Forestry Monument",
        "Hunting Monument Upgrade",
        "Lodge",
        "Mining Monument",
        "Warehouse Upgrade"
      ]);
    expect(screen.getByRole("button", { name: "Build City House" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build City Warehouse" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build Lodge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build Barracks" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build Demolition Factory" })).toBeTruthy();
    expect(screen.getByText("Lodge", { exact: true })).toBeTruthy();
    expect(screen.getByText("Barracks", { exact: true })).toBeTruthy();
    expect(screen.getByText("Demolition Factory", { exact: true })).toBeTruthy();
    for (const requirement of [
      "100 iron bar",
      "100 sulfur",
      "200 cloth",
      "500 wood"
    ]) {
      expect(screen.getByText(requirement, { exact: true })).toBeTruthy();
    }
    expect(screen.queryByText("350 wood", { exact: true })).toBeNull();
    expect(screen.queryByText("250 stone", { exact: true })).toBeNull();
    expect(screen.queryByText("750 City Coins", { exact: true })).toBeNull();
    expect(screen.queryByText(/Armory|Powder Works|Siege Workshop|War Camp/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade to Tier 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build City Market" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build Mining Monument" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build Forestry Monument" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade Hunting Monument to Tier 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build City" })).toBeTruthy();
    expect(screen.getByText("25 Wood")).toBeTruthy();
    expect(screen.getByText("15 Stone")).toBeTruthy();
    expect(screen.getAllByText("City territory").length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "City" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Personal" }));
    fireEvent.click(screen.getByRole("button", { name: "Build Flag" }));
    expect(build).toHaveBeenCalledOnce();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        automaticLayoutMode="wide"
        effectiveLayoutMode="wide"
        menuView="build"
        actions={[]}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "City" }));
    expect(screen.getByRole("button", { name: "Build City House" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build City Warehouse" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Kingdom" }));
    expect(screen.getByRole("button", { name: "Build Kingdom" })).toBeTruthy();
  });

  it("invokes the Furnace Build-menu action exactly once", () => {
    const buildFurnace = vi.fn();
    const furnace = {
      id: "furnace",
      category: "personal",
      icon: "furnace",
      title: "Furnace",
      description: "Smelt Iron Ore into Iron Bars.",
      requirements: [
        { itemId: "stone", quantity: 25 },
        { itemId: "wood", quantity: 100 },
        { itemId: "coal", quantity: 10 }
      ],
      guidance: "Builds immediately at your current position.",
      actionLabel: "Build Furnace",
      enabled: true,
      disabledReason: null,
      execute: buildFurnace
    } satisfies PhoneBuildOption;

    render(
      <PhoneHud
        {...persistentProps}
        buildOptions={[furnace]}
        menuView="build"
        actions={[]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Build Furnace" }));
    expect(buildFurnace).toHaveBeenCalledOnce();
  });

  it("marks material chips green or red and shows one check/X status without duplicated requirement text", () => {
    const base = {
      id: "furnace", category: "personal", icon: "furnace", title: "Furnace", description: "Smelt Iron Ore into Iron Bars.",
      requirements: [{ itemId: "stone", quantity: 25 }, { itemId: "wood", quantity: 100 }],
      guidance: "Requires 25 Stone and 100 Wood.", actionLabel: "Build Furnace", execute: vi.fn()
    } as const;
    const blocked = { ...base, enabled: false, disabledReason: "Requires 25 Stone and 100 Wood.", affordable: false, status: "Unavailable" } satisfies PhoneBuildOption;
    const view = render(<PhoneHud {...persistentProps} buildOptions={[blocked]} materialCounts={{ stone: 30, wood: 12 }} menuView="build" actions={[]} />);
    expect(screen.getByRole("img", { name: "Stone 25, have 30" }).getAttribute("data-state")).toBe("met");
    expect(screen.getByRole("img", { name: "Wood 100, have 12, missing 88" }).getAttribute("data-state")).toBe("short");
    expect(screen.getByRole("img", { name: "Cannot build yet" }).getAttribute("data-state")).toBe("blocked");
    expect(screen.queryByText(/needs materials/i)).toBeNull();
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByText(/Requires 25 Stone/)).toBeNull();
    view.rerender(<PhoneHud {...persistentProps} buildOptions={[{ ...base, enabled: true, disabledReason: null, affordable: true, status: "Available", guidance: "Builds immediately." }]} materialCounts={{ stone: 30, wood: 120 }} menuView="build" actions={[]} />);
    expect(screen.getByRole("img", { name: "Can build" }).getAttribute("data-state")).toBe("ready");
    expect(screen.getByRole("img", { name: "Wood 100, have 120" }).getAttribute("data-state")).toBe("met");
    const manor = { ...base, enabled: false, disabledReason: "Build a Manor first.", guidance: "Build a Manor first." } satisfies PhoneBuildOption;
    view.rerender(<PhoneHud {...persistentProps} buildOptions={[manor]} materialCounts={{ stone: 30, wood: 120 }} menuView="build" actions={[]} />);
    expect(screen.getAllByText("Build a Manor first.")).toHaveLength(1);
  });

  it("does not render the removed overflow action trigger", () => {
    render(<PhoneHud {...persistentProps} menuView="gameplay" actions={Array.from({ length: 7 }, (_, index) => makeAction(`Action ${index}`, 20 - index))} />);
    expect(screen.queryByRole("button", { name: /more actions/i })).toBeNull();
  });

  it("does not mount empty, locked, cooling-down, or unavailable combat skills", () => {
    const now = Date.now();
    const lockedAndEmpty = {
      ...readyClassSnapshot,
      warrior: { ...readyClassSnapshot.warrior, level: 4 },
      loadout: {
        ...readyClassSnapshot.loadout,
        resetActives: [null, null],
        normalActives: [null, null]
      },
      serverTime: now
    } satisfies ClassSnapshot;
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        classSnapshot={lockedAndEmpty}
        combat={combatWithSession()}
        equipment={readyEquipment}
      />
    );
    const skills = view.container.querySelectorAll<HTMLButtonElement>(".legacy-skill-button:not(.legacy-ultimate-button)");
    expect(skills).toHaveLength(0);

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        classSnapshot={{ ...readyClassSnapshot, serverTime: now }}
        combat={combatWithSession({ warrior_anger_explosion: now + 8_000 })}
        equipment={readyEquipment}
      />
    );
    expect(view.container.querySelectorAll(".legacy-skill-button")).toHaveLength(0);

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        classSnapshot={{ ...readyClassSnapshot, serverTime: now }}
        combat={combatWithSession()}
        equipment={null}
      />
    );
    expect(view.container.querySelectorAll(".legacy-skill-button")).toHaveLength(0);
  });

  it("does not render the compact combat cluster outside gameplay", () => {
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="menu"
        actions={[]}
        classSnapshot={readyClassSnapshot}
        combat={combatWithSession()}
        equipment={readyEquipment}
      />
    );
    expect(view.container.querySelector(".legacy-controls-right")).toBeNull();
  });

  it("owns Return to Game for the root and leaves real destinations a single native Back", () => {
    const onBack = vi.fn();
    const view = render(<PhoneHud {...persistentProps} menuView="menu" actions={[]} onBack={onBack} />);
    const returnToGame = screen.getByRole("button", { name: "Return to Game" });
    expect(returnToGame.querySelector("svg")).toBeNull();
    fireEvent.click(returnToGame);
    view.rerender(<PhoneHud {...persistentProps} menuView="pet-chamber" actions={[]} onBack={onBack} />);
    expect(screen.getByRole("dialog", { name: "Pets" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Game Menu" }));
    view.rerender(<PhoneHud {...persistentProps} menuView="classes" actions={[]} onBack={onBack} />);
    expect(screen.queryByRole("button", { name: "Back to Game Menu" })).toBeNull();
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it("renders canonical root apps without reorder or player preferences", () => {
    window.localStorage.setItem("ashAtlas.player.p.mobileMenuOrder.v1", JSON.stringify(["world-map", "profile"]));
    const view = render(<PhoneHud {...persistentProps} menuView="menu" actions={[]} />);
    expect(Array.from(view.container.querySelectorAll<HTMLElement>(".phone-menu-root [data-mobile-menu-id]"), ({ dataset }) => dataset.mobileMenuId)).toEqual([

      "equipment", "classes", "pet-chamber", "creature-book",
      "messages", "contacts", "party", "leaderboards",
      "world-map", "crafting", "build", "flags"
    ]);
    expect(Array.from(view.container.querySelectorAll<HTMLElement>(".phone-menu-header-actions [data-mobile-menu-id]"), ({ dataset }) => dataset.mobileMenuId)).toEqual([
      "announcements", "miscellaneous"
    ]);
    expect(view.container.querySelectorAll("[data-mobile-menu-category]")).toHaveLength(0);
    expect(screen.queryByText(/hold and drag/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /reorder/i })).toBeNull();
    expect(screen.queryByText("Action hand")).toBeNull();
    expect(screen.queryByText(/auto-jump/i)).toBeNull();
  });

  it("does not execute a rapid action click twice and uses the canonical right-handed rail", () => {
    window.localStorage.setItem("ashAtlas.phone.handedness", "left");
    const execute = vi.fn();
    const view = render(<PhoneHud {...persistentProps} menuView="gameplay" actions={[makeAction("Attack", 10, execute)]} />);
    const attack = screen.getByRole("button", { name: "Attack" });
    fireEvent.click(attack);
    fireEvent.click(attack);
    expect(execute).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".phone-action-rail-right")?.textContent).toContain("Attack");
  });

  it("keeps side quick-slot expansion independent, reverses each chevron, and invokes the action callback", () => {
    const leftExecute = vi.fn();
    const rightExecute = vi.fn();
    const leftAction = { ...makeAction("Left Action", 20, leftExecute), preferredSide: "left" as const };
    const rightAction = makeAction("Right Action", 10, rightExecute);
    render(<PhoneHud {...persistentProps} menuView="gameplay" actions={[leftAction, rightAction]} />);

    const leftToggle = screen.getByRole("button", { name: "Expand left quick slots" });
    const rightToggle = screen.getByRole("button", { name: "Expand right quick slots" });
    expect(leftToggle.querySelector("path")?.getAttribute("d")).toBe("m9 4 6 8-6 8");
    expect(rightToggle.querySelector("path")?.getAttribute("d")).toBe("m15 4-6 8 6 8");

    fireEvent.click(leftToggle);
    expect(leftToggle.getAttribute("aria-expanded")).toBe("true");
    expect(leftToggle.querySelector("path")?.getAttribute("d")).toBe("m15 4-6 8 6 8");
    fireEvent.click(screen.getByRole("button", { name: "Left Action" }));
    expect(leftExecute).toHaveBeenCalledOnce();

    fireEvent.click(rightToggle);
    expect(leftToggle.getAttribute("aria-expanded")).toBe("true");
    expect(rightToggle.getAttribute("aria-expanded")).toBe("true");
    expect(rightToggle.querySelector("path")?.getAttribute("d")).toBe("m9 4 6 8-6 8");
    fireEvent.click(screen.getByRole("button", { name: "Right Action" }));
    expect(rightExecute).toHaveBeenCalledOnce();

    fireEvent.click(leftToggle);
    expect(leftToggle.getAttribute("aria-expanded")).toBe("false");
    expect(leftToggle.querySelector("path")?.getAttribute("d")).toBe("m9 4 6 8-6 8");
    expect(rightToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens Inventory exactly once from every part of the status ledger", () => {
    const onOpenDestination = vi.fn();
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        aggressiveRemainingMs={6_200}
        flagArrivalProtectionRemainingMs={9_400}
        onOpenDestination={onOpenDestination}
      />
    );
    const footer = screen.getByRole("contentinfo", { name: "Phone bottom HUD" });
    expect(footer.querySelector(".phone-field-rail-heading")).toBeNull();
    expect(footer.querySelectorAll(":scope > section, :scope > .phone-bottom-menu-compartment, :scope > .phone-bottom-economy-compartment")).toHaveLength(3);
    expect(footer.querySelectorAll(".status-bar-phone-dock")).toHaveLength(3);
    expect(footer.querySelectorAll(".status-bar-compact-icon")).toHaveLength(3);
    expect(footer.querySelectorAll(".status-bar-compact-label .sr-only")).toHaveLength(3);
    expect(footer.querySelectorAll(".phone-menu-trigger")).toHaveLength(1);
    expect(footer.querySelector(".phone-menu-trigger")?.textContent).toBe("Menu");
    expect(footer.querySelector(".phone-inventory-trigger")).toBeNull();
    expect(footer.querySelector(".status-bar-experience .aggressive-timer")).toBeNull();
    const economy = screen.getByRole("button", {
      name: "Open Inventory. Aggression 6.2s. Carrying 1,004 of 1,200 kg, 196 kg free. Gold 1,250."
    });
    expect(economy.querySelector(".phone-economy-state-value")?.textContent).toBe("6.2s");
    expect(economy.querySelector(".phone-economy-storage-value")?.textContent).toBe("196");
    expect(economy.querySelector(".phone-economy-gold strong")?.textContent).toBe("1,250");
    expect(economy.tagName).toBe("BUTTON");
    expect(economy.getAttribute("type")).toBe("button");
    expect(economy.querySelectorAll("button")).toHaveLength(0);
    expect(footer.querySelectorAll(".phone-bottom-economy")).toHaveLength(1);
    expect(economy.querySelector(".phone-economy-state")?.getAttribute("data-player-state")).toBe("aggression");
    expect(economy.querySelector(".phone-player-state-glyph")?.classList.contains("phone-player-state-glyph-aggression")).toBe(true);
    const aggressionTrack = economy.querySelector(".phone-economy-state-track");
    expect(aggressionTrack).toBeTruthy();
    expect(aggressionTrack?.getAttribute("role")).toBe("progressbar");
    expect(aggressionTrack?.getAttribute("aria-valuemin")).toBe("0");
    expect(aggressionTrack?.getAttribute("aria-valuemax")).toBe("10000");
    expect(aggressionTrack?.getAttribute("aria-valuenow")).toBe("6200");
    expect(aggressionTrack?.querySelector(".phone-economy-state-fill")?.getAttribute("style")).toBe("width: 62%;");
    expect(economy.querySelector(".phone-economy-state-copy .sr-only")?.textContent).toBe("Aggression");
    expect(economy.querySelector(".phone-economy-state-value")?.textContent).toBe("6.2s");
    expect(economy.querySelectorAll(".phone-economy-row-icon")).toHaveLength(2);
    expect(economy.querySelector(".phone-economy-gold .sr-only")?.textContent).toBe("Gold");
    expect(economy.querySelector(".phone-economy-storage .sr-only")?.textContent).toBe("Carry");

    const economyTargets = [
      economy.querySelector(".phone-economy-storage strong"),
      economy.querySelector(".phone-economy-gold span"),
      economy.querySelector(".phone-economy-state strong"),
      economy
    ];
    for (const [index, target] of economyTargets.entries()) {
      expect(target).not.toBeNull();
      fireEvent.click(target!);
      expect(onOpenDestination).toHaveBeenCalledTimes(index + 1);
      expect(onOpenDestination).toHaveBeenLastCalledWith("equipment");
    }

    economy.focus();
    expect(document.activeElement).toBe(economy);
    expect(document.body.querySelectorAll(".phone-bottom-bar")).toHaveLength(1);
    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        walletGold="9999999999999999999"
        inventoryUsed="9000"
        inventoryTotal="16000"
        aggressiveRemainingMs={6_200}
        flagArrivalProtectionRemainingMs={9_400}
      />
    );
    expect(screen.getByRole("button", {
      name: "Open Inventory. Aggression 6.2s. Carrying 9 of 16 kg, 7 kg free. Gold 9,999,999,999,999,999,999."
    }).querySelector(".phone-economy-storage-value")?.textContent).toBe("7");
    expect(footer.querySelector(".status-bar-experience .aggressive-timer")).toBeNull();

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        aggressiveRemainingMs={0}
        flagArrivalProtectionRemainingMs={0}
      />
    );
    const inactiveEconomy = screen.getByRole("button", {
      name: "Open Inventory. No active player state. Carrying 1,004 of 1,200 kg, 196 kg free. Gold 1,250."
    });
    expect(inactiveEconomy.querySelector(".phone-economy-state")?.getAttribute("data-player-state")).toBe("none");
    expect(inactiveEconomy.querySelector(".phone-player-state-glyph")?.classList.contains("phone-player-state-glyph-none")).toBe(true);
    expect(inactiveEconomy.querySelector(".phone-player-state-glyph-none path")?.getAttribute("d")).toBe("M8.5 14c1.8 2.4 5.2 2.4 7 0");
    expect(inactiveEconomy.querySelector(".phone-economy-state-copy .sr-only")?.textContent).toBe("State");
    expect(inactiveEconomy.querySelector(".phone-economy-state-value")?.textContent).toBe("Ready");

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        aggressiveRemainingMs={0}
        flagArrivalProtectionRemainingMs={9_400}
      />
    );
    const protectedEconomy = screen.getByRole("button", {
      name: "Open Inventory. Protection 10s; move or attack to end. Carrying 1,004 of 1,200 kg, 196 kg free. Gold 1,250."
    });
    expect(protectedEconomy.querySelector(".phone-economy-state")?.getAttribute("data-player-state")).toBe("protection");
    expect(protectedEconomy.querySelector(".phone-player-state-glyph")?.classList.contains("phone-player-state-glyph-protection")).toBe(true);
    expect(protectedEconomy.querySelector(".phone-player-state-glyph-protection ellipse")).not.toBeNull();
    expect(protectedEconomy.querySelector(".phone-economy-state-track")?.getAttribute("role")).toBe("progressbar");
    expect(protectedEconomy.querySelector(".phone-economy-state-track")?.getAttribute("aria-valuenow")).toBe("9400");
    expect(protectedEconomy.querySelector(".phone-economy-state-fill")?.getAttribute("style")).toBe("width: 94%;");
    expect(protectedEconomy.querySelector(".phone-economy-state-copy .sr-only")?.textContent).toBe("Protection");
    expect(protectedEconomy.querySelector(".phone-economy-state-value")?.textContent).toBe("10s");
  });

  it("drains the aggression track as the authoritative remaining deadline decreases", () => {
    const view = render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        aggressiveRemainingMs={8_000}
      />
    );

    expect(document.body.querySelector(".phone-economy-state-fill")?.getAttribute("style")).toBe("width: 80%;");

    view.rerender(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        aggressiveRemainingMs={2_500}
      />
    );

    expect(document.body.querySelector(".phone-economy-state-fill")?.getAttribute("style")).toBe("width: 25%;");
  });

  it("drains protection against the server grant duration and clears it on expiry", () => {
    const view = render(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} aggressiveRemainingMs={0} flagArrivalProtectionRemainingMs={10_500} />);
    const track = screen.getByRole("progressbar", { name: "Protection time remaining" });
    expect(track.getAttribute("aria-valuemax")).toBe("10000");
    expect(track.getAttribute("aria-valuenow")).toBe("10000");
    expect(track.querySelector(".phone-economy-state-fill")?.getAttribute("style")).toBe("width: 100%;");
    for (const remaining of [7_500, 2_500]) {
      view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} aggressiveRemainingMs={0} flagArrivalProtectionRemainingMs={remaining} />);
      expect(track.getAttribute("aria-valuenow")).toBe(String(remaining));
      expect(track.querySelector(".phone-economy-state-fill")?.getAttribute("style")).toBe(`width: ${remaining / 100}%;`);
    }
    view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} aggressiveRemainingMs={0} flagArrivalProtectionRemainingMs={0} />);
    expect(screen.queryByRole("progressbar", { name: "Protection time remaining" })).toBeNull();
    expect(document.body.querySelector(".phone-economy-state")?.getAttribute("data-player-state")).toBe("none");
  });

  it("uses the missing-material warning treatment when carrying weight reaches capacity", () => {
    render(
      <PhoneHud
        {...persistentProps}
        menuView="gameplay"
        actions={[]}
        inventoryUsed="41000"
        inventoryTotal="41000"
      />
    );

    const inventory = screen.getByRole("button", {
      name: "Open Inventory. No active player state. Carrying 41 of 41 kg, 0 kg free. Gold 1,250. Inventory full."
    });
    expect(inventory.classList.contains("inventory-full")).toBe(true);
    expect(inventory.getAttribute("title")).toBe("Inventory full — open inventory");
  });

  it("meters actual carry occupancy without inventing capacity or gold progress", () => {
    const view = render(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} inventoryUsed={6000} inventoryTotal={40000} />);
    const meter = screen.getByRole("meter", { name: "Storage used" });
    expect(meter.getAttribute("aria-valuemax")).toBe("40000");
    expect(meter.getAttribute("aria-valuenow")).toBe("6000");
    expect(meter.getAttribute("aria-valuetext")).toBe("6 of 40 kg used");
    expect(meter.firstElementChild?.getAttribute("style")).toBe("width: 15%;");
    expect(document.body.querySelector(".phone-economy-gold [role]")).toBeNull();
    for (const [used, expected] of [[0, 0], [40000, 100], [45000, 100]] as const) {
      view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} inventoryUsed={used} inventoryTotal={40000} />);
      expect(meter.getAttribute("aria-valuenow")).toBe(String(Math.min(used, 40000)));
      expect(meter.firstElementChild?.getAttribute("style")).toBe(`width: ${expected}%;`);
    }
    view.rerender(<PhoneHud {...persistentProps} menuView="gameplay" actions={[]} inventoryUsed={0} inventoryTotal={0} />);
    expect(screen.queryByRole("meter", { name: "Storage used" })).toBeNull();
    expect(document.body.querySelector(".phone-economy-storage-track")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.querySelector(".phone-economy-storage-fill")).toBeNull();
  });
});
