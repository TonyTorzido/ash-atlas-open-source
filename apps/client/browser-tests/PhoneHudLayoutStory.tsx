import type {
  CombatEntitySnapshot,
  MarketInteger,
  ProgressionSnapshot
} from "@ash-atlas/shared";
import { useLayoutEffect, useState } from "react";
import { useMenuTheme, type MenuTheme } from "../src/ui/menuTheme.js";

import {
  MOBILE_MENU_DESTINATIONS,
  type MobileMenuCategoryId
} from "../src/mobileGameMenu.js";
import {
  PhoneHud,
  type PhoneBuildOption,
  type PhoneMenuDestination
} from "../src/ui/PhoneHud.js";

const progression: ProgressionSnapshot = {
  playerId: "self",
  totalXp: 500_000,
  level: 20,
  curveVersion: 1,
  persistenceVersion: 1,
  xpIntoLevel: 500_000,
  xpForNextLevel: 500_000,
  nextLevelTotalXp: 500_000,
  atCap: false,
  pveStats: {
    maxHealth: 100,
    attackPower: 10,
    defense: 5,
    attackIntervalMs: 1_000,
    attackRangeM: 2
  }
};

const combat: CombatEntitySnapshot = {
  entityId: "self",
  kind: "player",
  archetypeKey: null,
  name: "Player",
  level: 20,
  regionCode: "NM",
  zoneId: "world:NM",
  lat: 35,
  lon: -106,
  maxHealth: 100,
  currentHealth: 72,
  lifeState: "alive",
  activityState: "idle",
  targetEntityId: null,
  revision: 1,
  classCombat: {
    activeClassId: "warrior",
    resource: {
      resourceId: "rage",
      displayName: "Rage",
      current: 100,
      maximum: 100,
      reserved: 0
    },
    rage: 100,
    maximumRage: 100,
    reservedRage: 0,
    guard: 0,
    bloodlust: 0,
    queuedAbility: null,
    cooldownEndsAt: {}
  }
};

export function PhoneHudLayoutStory({
  quickSlots = false,
  presentation = "touch",
  safeAreaBottom = 34,
  walletGold = "9999999999999999999",
  inventoryUsed = 7,
  inventoryTotal = 16,
  aggressiveRemainingMs = 6_200,
  healthCurrent = 72,
  hungerCurrent = 1_200,
  flagArrivalProtectionRemainingMs = 0,
  menuView = "gameplay",
  gameplayReady = true,
  hideBottomDock = false,
  layoutMode = "compact",
  menuTheme = "light",
  onMenuThemeChange,
  onOpenDeveloperTools,
  children,
  iosStandalone = false
}: {
  quickSlots?: boolean;
  presentation?: "touch" | "desktop";
  safeAreaBottom?: number;
  walletGold?: MarketInteger;
  inventoryUsed?: number;
  inventoryTotal?: number;
  aggressiveRemainingMs?: number;
  healthCurrent?: number;
  hungerCurrent?: number;
  flagArrivalProtectionRemainingMs?: number;
  menuView?: "gameplay" | "build" | "menu" | "miscellaneous";
  menuTheme?: MenuTheme;
  onMenuThemeChange?: ((theme: MenuTheme) => void) | undefined;
  onOpenDeveloperTools?: (() => void) | undefined;
  children?: React.ReactNode;
  gameplayReady?: boolean;
  hideBottomDock?: boolean;
  layoutMode?: "compact" | "wide";
  iosStandalone?: boolean;
}): React.JSX.Element {
  const [mapTaps, setMapTaps] = useState(0);
  const [inventoryOpens, setInventoryOpens] = useState(0);
  const [menuCategory, setMenuCategory] = useState<MobileMenuCategoryId | null>(null);
  const destinations: readonly PhoneMenuDestination[] = menuView === "menu" || presentation === "desktop"
    ? gameMenuDestinations
    : menuView === "build"
      ? [{ id: "build" }]
      : menuView === "miscellaneous" ? [{ id: "miscellaneous" }] : [];

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousPresentation = root.dataset.presentation;
    const previousProfile = root.dataset.uiProfile;
    const previousLayoutMode = root.dataset.layoutMode;
    const previousIosStandalone = root.dataset.iosStandalone;
    const previousSafeBottom = root.style.getPropertyValue("--hud-safe-bottom");
    root.dataset.uiProfile = "phone";
    root.dataset.presentation = presentation;
    root.dataset.layoutMode = layoutMode;
    if (iosStandalone) root.dataset.iosStandalone = "true";
    else delete root.dataset.iosStandalone;
    root.style.setProperty("--hud-safe-bottom", `${safeAreaBottom}px`);
    return () => {
      if (previousPresentation === undefined) delete root.dataset.presentation;
      else root.dataset.presentation = previousPresentation;
      if (previousProfile === undefined) delete root.dataset.uiProfile;
      else root.dataset.uiProfile = previousProfile;
      if (previousLayoutMode === undefined) delete root.dataset.layoutMode;
      else root.dataset.layoutMode = previousLayoutMode;
      if (previousIosStandalone === undefined) delete root.dataset.iosStandalone;
      else root.dataset.iosStandalone = previousIosStandalone;
      if (previousSafeBottom) root.style.setProperty("--hud-safe-bottom", previousSafeBottom);
      else root.style.removeProperty("--hud-safe-bottom");
    };
  }, [iosStandalone, layoutMode, safeAreaBottom, presentation]);

  const stageContent = <>
    <div
      className="phone-hud-layout-map"
      data-testid="map-background"
      onPointerDown={() => setMapTaps((value) => value + 1)}
    />
    <PhoneHud
        presentation={presentation}
        player={{ username: "LoadoutQA", displayColor: null, appearance: { schemaVersion: 1, catalogRevision: 1, revision: 1, bodyVariantId: "default", poseId: "idle", slots: {}, styles: { hair: "hair-1" }, activeHand: null } }}
        actions={quickSlots ? (["left", "right"] as const).map((side) => ({ id: side, label: `${side} action`, icon: "attack" as const, category: "combat" as const, priority: 1, preferredSide: side, enabled: true, execute: () => undefined })) : []}
        buildOptions={menuView === "build" ? buildOptions : []}
        destinations={destinations}
        menuView={menuView}
        gameplayReady={gameplayReady}
        hideBottomDock={hideBottomDock}
        menuCategory={menuView === "menu" ? menuCategory : null}
        progression={progression}
        achievements={null}
        combat={{ ...combat, currentHealth: healthCurrent }}
        hunger={{ current: hungerCurrent, baseCapacity: 2_000 }}
        classSnapshot={null}
        equipment={null}
        combatControlsDisabled={false}
        synchronizedNow={Date.now}
        aggressiveRemainingMs={aggressiveRemainingMs}
        flagArrivalProtectionRemainingMs={flagArrivalProtectionRemainingMs}
        walletGold={walletGold}
        inventoryUsed={inventoryUsed}
        inventoryTotal={inventoryTotal}
        developerAccessEnabled={false}
        zoomIndicatorEnabled={false}
        mobileDefaultZoom={15}
        tapAssistancePreference="standard"
        menuTheme={menuTheme}
        {...(onMenuThemeChange ? { onMenuThemeChange } : {})}
        {...(onOpenDeveloperTools ? { onOpenDeveloperTools } : {})}
        layoutPreference="automatic"
        automaticLayoutMode={layoutMode}
        effectiveLayoutMode={layoutMode}
        inputMode="touch"
        wideOverrideBlocked={false}
        onOpenMenu={() => undefined}
        onOpenCategory={(category) => {
          if (menuView === "menu") setMenuCategory(category);
        }}
        onOpenDestination={(id) => {
          if (id === "equipment") setInventoryOpens((value) => value + 1);
        }}
        onBack={() => setMenuCategory(null)}
        onLogout={() => undefined}
        onZoomIndicatorChange={() => undefined}
        onMobileDefaultZoomChange={() => undefined}
        onResetMobileDefaultZoom={() => undefined}
        onTapAssistancePreferenceChange={() => undefined}
        onLayoutPreferenceChange={() => undefined}
        onRecenter={() => undefined}
        onOpenWorldMap={() => undefined}
        onUseNormalAbility={() => undefined}
        onUseResetAbility={() => undefined}
        onUseUniversalTaunt={() => undefined}
    />
  </>;

  return (
    <main className="phone-hud-layout-story app-presentation">
      {layoutMode === "wide" ? (
        <div className="mobile-app-stage" data-testid="mobile-app-stage" data-gameplay-ui="canonical-wide">
          {children}
          {stageContent}
        </div>
      ) : stageContent}
      <output data-testid="map-taps">{mapTaps}</output>
      <output data-testid="inventory-opens">{inventoryOpens}</output>
      <style>{`
        .phone-hud-layout-story,
        .phone-hud-layout-map {
          position: fixed;
          inset: 0;
        }
        .phone-hud-layout-story {
          container: mobile-app / size;
        }
        .phone-hud-layout-map {
          background:
            repeating-linear-gradient(135deg, rgb(124 151 91 / 28%) 0 14px, transparent 14px 28px),
            linear-gradient(180deg, #42553a, #1d2d22);
        }
        .phone-hud-layout-story > output {
          position: fixed;
          z-index: 200;
          top: 0;
          left: 0;
          pointer-events: none;
          opacity: 0;
        }
      `}</style>
    </main>
  );
}

export function BuildCenterCompactStory(): React.JSX.Element {
  return (
    <PhoneHudLayoutStory
      menuView="build"
      layoutMode="compact"
    />
  );
}

export function BuildCenterWideStory(): React.JSX.Element {
  return (
    <PhoneHudLayoutStory
      menuView="build"
      layoutMode="wide"
    />
  );
}

export function GameMenuLedgerStory(): React.JSX.Element {
  return <PhoneHudLayoutStory menuView="menu" />;
}

export function MenuAppearanceStory(): React.JSX.Element {
  const [menuTheme, onMenuThemeChange] = useMenuTheme("appearance-browser-test");
  return <PhoneHudLayoutStory menuView="miscellaneous" menuTheme={menuTheme} onMenuThemeChange={onMenuThemeChange} />;
}

const gameMenuDestinations: readonly PhoneMenuDestination[] = MOBILE_MENU_DESTINATIONS.map(({ id }) => {
  if (id === "messages") {
    return {
      id,
      badge: "3",
      badgeCount: 3,
      badgeAccessibleLabel: "3 unread messages"
    };
  }
  if (id === "party") {
    return {
      id,
      badge: "2",
      badgeCount: 2,
      badgeAccessibleLabel: "2 pending party invites"
    };
  }
  if (id === "achievements") {
    return {
      id,
      badge: "4/9",
      badgeAccessibleLabel: "4 of 9 achievements complete"
    };
  }
  if (id === "world-map") {
    return {
      id,
      disabledReason: "Exit the interior to open the World Map."
    };
  }
  return { id };
});

const buildOptions: readonly PhoneBuildOption[] = [
  buildOption("flag", "personal", "flag", "Territory Flag"),
  buildOption("manor", "personal", "manor", "Manor"),
  buildOption("decoration:shrine", "personal", "decoration", "Personal Shrine"),
  buildOption("city", "city", "city", "Found City"),
  buildOption("city-house", "city", "city-house", "City House"),
  buildOption("lodge", "city", "lodge", "Lodge"),
  buildOption("barracks", "city", "barracks", "Barracks"),
  buildOption("demolition-factory", "city", "demolition-factory", "Demolition Factory"),
  buildOption("warehouse", "city", "warehouse", "City Warehouse"),
  buildOption("warehouse-upgrade", "city", "warehouse", "Warehouse Upgrade"),
  buildOption("market", "city", "market", "City Market"),
  buildOption("monument-mining", "city", "monument", "Mining Monument"),
  buildOption("kingdom", "kingdom", "kingdom", "Found Kingdom")
];

function buildOption(
  id: PhoneBuildOption["id"],
  category: PhoneBuildOption["category"],
  icon: PhoneBuildOption["icon"],
  title: string
): PhoneBuildOption {
  return {
    id,
    category,
    icon,
    title,
    description: `${title} construction`,
    status: "Unbuilt",
    requirements: ["Authoritative requirements"],
    guidance: "Stand at the construction site.",
    actionLabel: `Build ${title}`,
    enabled: true,
    disabledReason: null,
    execute: () => undefined
  };
}
