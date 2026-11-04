// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MOB_ARCHETYPE_KEYS,
  type CombatEntitySnapshot,
  type ProgressionSnapshot
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { BottomActionBar } from "./BottomActionBar.js";
import { DeveloperToolsPanel } from "./DeveloperToolsPanel.js";
import { ProgressionHud } from "./ProgressionHud.js";
import { TopBar } from "./TopBar.js";
import { DEV_PNG_ASSETS } from "../developer/devPngCatalog.js";
import { mobArtworkKey } from "../map/mobArtwork.js";

afterEach(cleanup);

describe("compact account utility", () => {
  it("keeps status, profile, flag color, sign out, and Escape focus restoration without branding", () => {
    const profile = vi.fn();
    const logout = vi.fn();
    render(<TopBar connectionStatus="online" username="Developer" playerId="player-123456" flagColor="#d83a3a" colorBusy={false} onFlagColorChange={vi.fn()} onOpenProfile={profile} onLogout={logout} />);
    expect(screen.queryByText("Ash Atlas")).toBeNull();
    expect(screen.getByLabelText("Connection online")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: /Developer/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Profile" }));
    expect(profile).toHaveBeenCalledOnce();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(logout).toHaveBeenCalledOnce();
  });
});

describe("player status HUD", () => {
  it("uses authoritative health, dynamic resource, XP, and low-health semantics", () => {
    const view = render(<ProgressionHud progression={progression()} combat={combat()} classSnapshot={null} />);
    expect(screen.getByText("20 / 100")).toBeTruthy();
    expect(screen.getByText("Focus")).toBeTruthy();
    expect(screen.getByText("35 / 100")).toBeTruthy();
    expect(screen.getByText("420 / 1,000")).toBeTruthy();
    expect(view.container.querySelector(".low-health")).toBeTruthy();
  });

  it("handles a zero maximum safely", () => {
    const zero = { ...combat(), maxHealth: 0, currentHealth: 0 };
    const view = render(<ProgressionHud progression={progression()} combat={zero} classSnapshot={null} />);
    expect(view.container.querySelector('[aria-label="Health"]')?.getAttribute("aria-valuemax")).toBe("0");
  });

  it("aligns health and experience and adds a class resource row only when one exists", () => {
    const view = render(<ProgressionHud progression={progression()} combat={null} classSnapshot={null} variant="phoneDock" />);
    expect(Array.from(view.container.querySelectorAll(".status-bar-compact-label"), (label) => label.textContent)).toEqual(["HP", "EXP"]);
    view.rerender(<ProgressionHud progression={progression()} combat={combat()} classSnapshot={null} variant="phoneDock" />);
    const rows = Array.from(view.container.querySelectorAll(".status-bar"));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector(".status-bar-compact-label")?.textContent)).toEqual(["HP", "EXP", "FOCUS"]);
    expect(rows.every((row) => row.querySelector(".status-bar-track"))).toBe(true);
    expect(rows.map((row) => row.querySelector(".status-bar-compact-value")?.textContent)).toEqual(["20/100", "420/1,000", "35/100"]);
    expect(view.container.querySelectorAll("[data-phone-label], [data-phone-value]")).toHaveLength(0);
  });

  it("renders Aggressive as a compact timer on the XP row without the old message block", () => {
    const view = render(<ProgressionHud progression={progression()} combat={combat()} classSnapshot={null} aggressiveRemainingMs={6_750} />);
    expect(screen.getByLabelText("Aggressive for 6.8s")).toBeTruthy();
    expect(screen.getByText("AGG 6.8s")).toBeTruthy();
    expect(screen.queryByText("Flag travel locked")).toBeNull();
    expect(view.container.querySelector(".aggressive-status")).toBeNull();
    expect(view.container.querySelector(".status-bar-experience.status-bar-phone-adorned")).toBeTruthy();
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.getByText("Focus")).toBeTruthy();
    expect(screen.getByText("Experience")).toBeTruthy();
  });
});

describe("gameplay action drawer", () => {
  it("starts collapsed, omits the legacy flag action and development controls, and restores focus on Escape", () => {
    const view = render(<BottomActionBar {...drawerProps()} disabled />);
    const trigger = screen.getByRole("button", { name: /Actions/ });
    expect(screen.queryByRole("region", { name: "Gameplay actions" })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: /Build Flag/ })).toBeNull();
    expect(screen.queryByText("Mob Spawner")).toBeNull();
    expect(screen.queryByText("Developer Tools")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("region", { name: "Gameplay actions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows construction only while the player has no built manor", () => {
    const build = vi.fn();
    const { rerender } = render(<BottomActionBar {...drawerProps()} onBuildManor={build} showBuildManor />);
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Build Manor" }));
    expect(build).toHaveBeenCalledOnce();
    rerender(<BottomActionBar {...drawerProps()} onBuildManor={build} showBuildManor={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    expect(screen.queryByRole("button", { name: "Build Manor" })).toBeNull();
  });

  it("routes Skills and Professions through one combined drawer action", () => {
    const openSkillsAndProfessions = vi.fn();
    render(<BottomActionBar {...drawerProps()} onToggleClasses={openSkillsAndProfessions} />);
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skills & Professions" }));
    expect(openSkillsAndProfessions).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Professions" })).toBeNull();
  });

  it("keeps Recenter as the drawer's separate map-position action", () => {
    render(<BottomActionBar {...drawerProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    expect(screen.getByRole("button", { name: "Recenter" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Relocate" })).toBeNull();
  });

  it("keeps menu panels indoors while hiding world-only actions", () => {
    render(<BottomActionBar {...drawerProps()} worldActionsAvailable={false} showBuildManor showBuildFurnace showBuildGreenhouse onBuildGreenhouse={vi.fn()} onToggleTolls={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    for (const name of [/^Inventory/, /^Market/, "Kingdom", "Skills & Professions"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    for (const name of ["Recenter", "Build Manor", "Build Furnace", "Build Greenhouse", "Flags", "Tolls"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("consolidated developer menu", () => {
  it("shows material grants from asset capability without exposing gold, test-kit, or progression controls", () => {
    const grantMaterial = vi.fn();
    render(<DeveloperToolsPanel {...developerMenuProps({
      assetGrantEnabled: true,
      economyMutationEnabled: false,
      onGrantMaterial: grantMaterial
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Economy" }));
    expect(screen.queryByRole("button", { name: "Grant Gold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+1,000 Gold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+10,000 Gold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Market test kit" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Material"), { target: { value: "leather" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant material" }));
    expect(grantMaterial).toHaveBeenCalledWith("leather", 500);
    fireEvent.change(screen.getByLabelText("Material"), {
      target: { value: "atlas_shrine_shard" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant material" }));
    expect(grantMaterial).toHaveBeenLastCalledWith("atlas_shrine_shard", 500);
    expect(screen.getByText("Atlas Shrine Shard: 0")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Material"), {
      target: { value: "balsam_resin" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant material" }));
    expect(grantMaterial).toHaveBeenLastCalledWith("balsam_resin", 500);
    expect(screen.getByText("Frond Sap: 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.queryByRole("button", { name: "Open progression controls" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset class ability cooldowns" })).toBeNull();
  });

  it("shows gold, test-kit, and progression controls only from economy mutation capability", () => {
    const grantGold = vi.fn();
    const grantCityCoins = vi.fn();
    const grantTestKit = vi.fn();
    const resetClassAbilityCooldowns = vi.fn();
    const resetSkillTreeV3 = vi.fn();
    render(<DeveloperToolsPanel {...developerMenuProps({
      assetGrantEnabled: false,
      economyMutationEnabled: true,
      onGrantGold: grantGold,
      onGrantCityCoins: grantCityCoins,
      onGrantTestKit: grantTestKit,
      onResetClassAbilityCooldowns: resetClassAbilityCooldowns,
      onResetSkillTreeV3: resetSkillTreeV3
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Economy" }));
    expect(screen.queryByRole("button", { name: "Grant material" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grant Gold" }));
    expect(grantGold).toHaveBeenCalledWith(1_000);
    fireEvent.click(screen.getByRole("button", { name: "Grant City Coins" }));
    expect(grantCityCoins).toHaveBeenCalledWith(1_000);
    fireEvent.click(screen.getByRole("button", { name: "Market test kit" }));
    expect(grantTestKit).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.getByRole("button", { name: "Open progression controls" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset class ability cooldowns" }));
    expect(resetClassAbilityCooldowns).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Reset V3 skill tree" }));
    expect(resetSkillTreeV3).toHaveBeenCalledOnce();
  });

  it("removes Economy controls when capabilities are lost and closes all tools on logout", async () => {
    const props = developerMenuProps({
      assetGrantEnabled: true,
      economyMutationEnabled: true
    });
    const view = render(<DeveloperToolsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Economy" }));
    expect(screen.getByRole("button", { name: "Grant Gold" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Grant material" })).toBeTruthy();

    view.rerender(<DeveloperToolsPanel
      {...props}
      assetGrantEnabled={false}
      economyMutationEnabled={false}
    />);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Economy" })).toBeNull()
    );
    expect(screen.queryByRole("button", { name: "Grant Gold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Grant material" })).toBeNull();

    view.rerender(<DeveloperToolsPanel {...props} developerAccessEnabled={false} />);
    expect(screen.queryByRole("dialog", { name: "Developer App" })).toBeNull();
  });

  it("filters generic Goblin and Bandit while preserving production Goblin presentation", () => {
    const chooseMob = vi.fn();
    render(<DeveloperToolsPanel {...developerMenuProps({ onChooseMob: chooseMob })} />);
    fireEvent.click(screen.getByRole("button", { name: "Spawning" }));

    for (const archetype of MOB_ARCHETYPE_KEYS.filter((key) => key !== "goblin" && key !== "bandit" && !key.startsWith("hollin_") || key === "hollin_hut")) {
      const label = archetype
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
    }
    expect(screen.queryByRole("button", { name: "Goblin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bandit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deer" }));
    expect(chooseMob).toHaveBeenCalledWith("deer", "normal");

    expect(mobArtworkKey("goblin", "goblin")).toBe("goblinBasic");
    expect(mobArtworkKey("goblin", "goblin_warrior")).toBe("goblinWarrior");
    expect(mobArtworkKey("goblin", "goblin_archer")).toBe("goblinArcher");
    expect(mobArtworkKey("goblin", "goblin_healer")).toBe("goblinHealer");
    const goblinCatalog = DEV_PNG_ASSETS
      .filter(({ sourcePath }) => sourcePath.includes("/goblins/"))
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
      .map(({ sourcePath, productionSource }) => [sourcePath, productionSource]);
    expect(goblinCatalog)
      .toEqual([
        ["apps/client/src/assets/goblins/goblin-archer.png", "SPRITE_PRESENTATION.goblinArcher"],
        ["apps/client/src/assets/goblins/goblin-basic.png", "SPRITE_PRESENTATION.goblinBasic"],
        ["apps/client/src/assets/goblins/goblin-hall.png", "SPRITE_PRESENTATION.goblinHall"],
        ["apps/client/src/assets/goblins/goblin-healer.png", "SPRITE_PRESENTATION.goblinHealer"],
        ["apps/client/src/assets/goblins/goblin-market.png", "WORLD_PNG_PRESENTATION.cityStructures.goblin_market"],
        ["apps/client/src/assets/goblins/goblin-warrior.png", "SPRITE_PRESENTATION.goblinWarrior"]
      ]);
  });

  it("offers no Ashen appearance choice for spawning", () => {
    const chooseMob = vi.fn();
    render(<DeveloperToolsPanel {...developerMenuProps({
      onChooseGoblinVillage: vi.fn(),
      onChooseMob: chooseMob
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Spawning" }));
    expect(screen.queryByRole("combobox", { name: "Appearance" })).toBeNull();
    expect((screen.getByRole("button", { name: "Goblin Village" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("exposes the capability-gated military test target and unit controls", () => {
    const chooseFlag = vi.fn();
    const chooseUnit = vi.fn();
    const props = developerMenuProps({
      onChooseMilitaryTestFlag: chooseFlag,
      onChooseMilitaryTestUnit: chooseUnit
    });
    const view = render(<DeveloperToolsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Spawning" }));

    for (const label of [
      "Spawn Test Soft Flag",
      "Spawn Test Bastion Flag",
      "Spawn Test Tower",
      "Spawn Siege",
      "Spawn Bomber",
      "Spawn Archer",
      "Spawn Melee Kippin"
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Spawn Test Tower" }));
    fireEvent.click(screen.getByRole("button", { name: "Spawn Bomber" }));
    expect(chooseFlag).toHaveBeenCalledWith("tower");
    expect(chooseUnit).toHaveBeenCalledWith("bomber");

    view.rerender(<DeveloperToolsPanel {...props} developerAccessEnabled={false} />);
    expect(screen.queryByRole("dialog", { name: "Developer App" })).toBeNull();
  });

  it("requires developer access, starts views off, toggles each view, and disables all views", () => {
    const resource = vi.fn(); const combatDiagnostics = vi.fn();
    const movementDiagnostics = vi.fn(); const geographyDiagnostics = vi.fn(); const mobileDiagnostics = vi.fn();
    const performance = vi.fn(); const zoomIndicator = vi.fn();
    const teleport = vi.fn();
    const disableViews = (): void => {
      resource(false); combatDiagnostics(false); movementDiagnostics(false);
      geographyDiagnostics(false); mobileDiagnostics(false); performance(false);
      zoomIndicator(false);
    };
    const props = developerMenuProps({ onResourceVisionChange: resource, onCombatDiagnosticsChange: combatDiagnostics, onMovementDiagnosticsChange: movementDiagnostics, onGeographyDiagnosticsChange: geographyDiagnostics, onMobileDiagnosticsChange: mobileDiagnostics, onPerformanceChange: performance, onZoomIndicatorChange: zoomIndicator, onTeleport: teleport, onDisableViews: disableViews });
    const view = render(<DeveloperToolsPanel {...props} developerAccessEnabled={false} />);
    expect(screen.queryByRole("dialog", { name: "Developer App" })).toBeNull();
    view.rerender(<DeveloperToolsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "World" }));
    fireEvent.click(screen.getByRole("button", { name: "Teleport" }));
    expect(teleport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Developer View" }));
    const toggles = [
      [/Show Zoom Level/, zoomIndicator],
      [/Show resource vision/, resource],
      [/Show combat diagnostics/, combatDiagnostics], [/Show movement \/ networking diagnostics/, movementDiagnostics],
      [/Show geography \/ resource diagnostics/, geographyDiagnostics], [/Show mobile diagnostics/, mobileDiagnostics],
      [/Show performance panel/, performance]
    ] as const;
    for (const [name, callback] of toggles) {
      const toggle = screen.getByRole("checkbox", { name });
      expect((toggle as HTMLInputElement).checked).toBe(false);
      fireEvent.click(toggle);
      expect(callback).toHaveBeenCalledWith(true);
    }
    view.rerender(<DeveloperToolsPanel {...props} zoomIndicatorEnabled resourceVisionEnabled combatDiagnosticsEnabled movementDiagnosticsEnabled geographyDiagnosticsEnabled mobileDiagnosticsEnabled performanceEnabled />);
    for (const [name, callback] of toggles) {
      const toggle = screen.getByRole("checkbox", { name });
      expect((toggle as HTMLInputElement).checked).toBe(true);
      fireEvent.click(toggle);
      expect(callback).toHaveBeenCalledWith(false);
    }
    fireEvent.click(screen.getByRole("button", { name: "Disable all developer views" }));
    for (const [, callback] of toggles) expect(callback).toHaveBeenCalledWith(false);
  });

  it("offers the zoom indicator only in the mobile developer menu", () => {
    const props = developerMenuProps();
    const view = render(<DeveloperToolsPanel {...props} zoomIndicatorAvailable={false} />);
    expect(screen.queryByRole("checkbox", { name: /Show Zoom Level/ })).toBeNull();

    view.rerender(<DeveloperToolsPanel {...props} zoomIndicatorAvailable />);
    expect(screen.getByRole("checkbox", { name: /Show Zoom Level/ })).toBeTruthy();
  });

  it("keeps Test Access inside the capability-gated Developer App", () => {
    const openTestAccess = vi.fn();
    const props = developerMenuProps({
      assetGrantEnabled: true,
      economyMutationEnabled: true,
      onOpenTestAccess: openTestAccess
    });
    const view = render(<DeveloperToolsPanel {...props} testAccessManageEnabled={false} />);
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Test Access" })).toBeNull();

    view.rerender(<DeveloperToolsPanel {...props} testAccessManageEnabled />);
    for (const section of [
      "Admin",
      "Economy",
      "World",
      "Spawning",
      "PNG Lab",
      "Permanent Mines",
      "Developer View",
      "Diagnostics"
    ]) {
      expect(screen.getByRole("button", { name: section })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Test Access" }));
    expect(openTestAccess).toHaveBeenCalledOnce();
  });
});

function developerMenuProps(overrides: Partial<ComponentProps<typeof DeveloperToolsPanel>> = {}): ComponentProps<typeof DeveloperToolsPanel> {
  return {
    open: true, developerAccessEnabled: true, worldMutationEnabled: true,
    inventory: { playerId: "p", revision: 0, items: [], totals: { wood: 0, stone: 0, coal: 0, iron: 0, sulfur: 0, iron_bar: 0, venomsteel_bar: 0, venomsteel_core: 0, fire_feather: 0, tempest_quill: 0, ice_feather: 0, fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0, food: 0, ore: 0, water: 0, leather: 0, deer_hide: 0, hog_hide: 0, wolf_pelt: 0, bear_hide: 0, alligator_hide: 0, squid_flesh: 0, crab_carapace: 0, raw_meat: 0, shell: 0, giving_berry: 0, balsam_resin: 0, crude_oil: 0, jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0, crystal: 0, pearl: 0, atlas_shrine_shard: 0, enchantment_stone: 0 } },
    walletGold: "0", busy: false, feedback: null, resourceVisionEnabled: false,
    combatDiagnosticsEnabled: false, movementDiagnosticsEnabled: false, geographyDiagnosticsEnabled: false,
    mobileDiagnosticsEnabled: false, performanceEnabled: false, zoomIndicatorEnabled: false,
    zoomIndicatorAvailable: true, activeArchetype: null,
    onClose: vi.fn(), onGrantGold: vi.fn(), onGrantCityCoins: vi.fn(), onGrantMaterial: vi.fn(), onGrantTestKit: vi.fn(),
    onResourceVisionChange: vi.fn(), onCombatDiagnosticsChange: vi.fn(),
    onMovementDiagnosticsChange: vi.fn(), onGeographyDiagnosticsChange: vi.fn(), onMobileDiagnosticsChange: vi.fn(),
    onPerformanceChange: vi.fn(), onZoomIndicatorChange: vi.fn(), onDisableViews: vi.fn(), onChooseMob: vi.fn(), onClearMobs: vi.fn(),
    onCancelSpawning: vi.fn(), onOpenConsole: vi.fn(), onOpenProgression: vi.fn(),
    onResetClassAbilityCooldowns: vi.fn(),
    ...overrides
  };
}

function progression(): ProgressionSnapshot { return { playerId: "p", totalXp: 6420, level: 4, curveVersion: 1, persistenceVersion: 1, xpIntoLevel: 420, xpForNextLevel: 1000, nextLevelTotalXp: 7000, atCap: false, pveStats: { maxHealth: 100, attackPower: 10, defense: 5, attackIntervalMs: 1000, attackRangeM: 2 } }; }
function combat(): CombatEntitySnapshot { return { entityId: "p", kind: "player", archetypeKey: null, name: "Player", level: 4, regionCode: "NM", zoneId: "world:NM", lat: 35, lon: -106, maxHealth: 100, currentHealth: 20, lifeState: "alive", activityState: "idle", targetEntityId: null, revision: 1, classCombat: { activeClassId: "hunter", resource: { resourceId: "focus", displayName: "Focus", current: 35, maximum: 100, reserved: 0 }, rage: 0, maximumRage: 100, reservedRage: 0, guard: 0, bloodlust: 0, queuedAbility: null, cooldownEndsAt: {} } }; }
function drawerProps() { return { onRecenter: vi.fn(), onToggleFlags: vi.fn(), onToggleInventory: vi.fn(), onToggleKingdom: vi.fn(), onToggleMarket: vi.fn(), onToggleClasses: vi.fn(), onBuildManor: vi.fn(), onBuildFurnace: vi.fn(), showBuildManor: true, showBuildFurnace: false, kingdomOpen: false, disabled: false }; }
