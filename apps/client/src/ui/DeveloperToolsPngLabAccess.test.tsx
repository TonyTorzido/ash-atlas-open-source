// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevPngLabController } from "../developer/devPngLabController.js";
import { DeveloperToolsPanel } from "./DeveloperToolsPanel.js";

afterEach(cleanup);

describe("Developer Tools PNG Lab access", () => {
  it("exposes session presentation preview only in the authorized Developer View", () => {
    const onChange = vi.fn();
    const view = render(<DeveloperToolsPanel {...props()} presentationPreview="auto" onPresentationPreviewChange={onChange} />);
    const control = screen.getByRole("combobox", { name: "Presentation preview" });
    fireEvent.change(control, { target: { value: "touch" } });
    expect(onChange).toHaveBeenCalledWith("touch");
    view.rerender(<DeveloperToolsPanel {...props()} developerAccessEnabled={false} onPresentationPreviewChange={onChange} />);
    expect(screen.queryByRole("combobox", { name: "Presentation preview" })).toBeNull();
    view.rerender(<DeveloperToolsPanel {...props()} developerObserveEnabled={false} testAccessManageEnabled onPresentationPreviewChange={onChange} />);
    expect(screen.queryByRole("combobox", { name: "Presentation preview" })).toBeNull();
  });
  it("is available with normal developer access and no mutation capabilities", () => {
    const view = render(<DeveloperToolsPanel {...props()} />);
    expect(screen.queryByRole("button", { name: "World" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Spawning" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "PNG Lab" }));
    expect(screen.getByRole("region", { name: "PNG Lab" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "UI Standards" }));
    expect(screen.getByRole("region", { name: "UI Standards Gallery" })).toBeTruthy();
    expect(view.container.querySelector(".game-compact-prompt")).toBeTruthy();
    expect(view.container.querySelector(".ui-standards-app-preview")).toBeTruthy();
  });

  it("is unavailable when the Developer App itself is unavailable", () => {
    render(<DeveloperToolsPanel {...props()} developerAccessEnabled={false} />);
    expect(screen.queryByRole("button", { name: "PNG Lab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "UI Standards" })).toBeNull();
  });

  it("shows Leaderboards only with its private capability", () => {
    const view = render(<DeveloperToolsPanel {...props()} />);
    expect(screen.queryByRole("button", { name: "Leaderboards" })).toBeNull();
    view.rerender(
      <DeveloperToolsPanel
        {...props()}
        privateLeaderboardsEnabled
        serverHttpBase="https://game.example"
      />
    );
    expect(screen.getByRole("button", { name: "Leaderboards" })).toBeTruthy();
  });
});

function props(): ComponentProps<typeof DeveloperToolsPanel> {
  return {
    open: true,
    developerAccessEnabled: true,
    worldMutationEnabled: false,
    assetGrantEnabled: false,
    economyMutationEnabled: false,
    inventory: {
      playerId: "p",
      revision: 0,
      items: [],
      totals: {
        wood: 0, stone: 0, coal: 0, iron: 0, sulfur: 0, iron_bar: 0, venomsteel_bar: 0, venomsteel_core: 0, fire_feather: 0, tempest_quill: 0, ice_feather: 0, fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0, food: 0, ore: 0, water: 0, leather: 0, deer_hide: 0, hog_hide: 0, wolf_pelt: 0, bear_hide: 0, alligator_hide: 0, squid_flesh: 0, crab_carapace: 0, raw_meat: 0, shell: 0,
        giving_berry: 0,
        balsam_resin: 0, crude_oil: 0, jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0, crystal: 0, pearl: 0, atlas_shrine_shard: 0, enchantment_stone: 0
      }
    },
    walletGold: "0",
    busy: false,
    feedback: null,
    resourceVisionEnabled: false,
    combatDiagnosticsEnabled: false,
    movementDiagnosticsEnabled: false,
    geographyDiagnosticsEnabled: false,
    mobileDiagnosticsEnabled: false,
    performanceEnabled: false,
    zoomIndicatorEnabled: false,
    zoomIndicatorAvailable: false,
    activeArchetype: null,
    pngLabController: new DevPngLabController(),
    mapZoom: 14,
    playerPosition: null,
    onStartPngPlacement: vi.fn(),
    onCenterPngPlacement: vi.fn(),
    onClose: vi.fn(),
    onGrantGold: vi.fn(),
    onGrantCityCoins: vi.fn(),
    onGrantMaterial: vi.fn(),
    onGrantTestKit: vi.fn(),
    onResourceVisionChange: vi.fn(),
    onCombatDiagnosticsChange: vi.fn(),
    onMovementDiagnosticsChange: vi.fn(),
    onGeographyDiagnosticsChange: vi.fn(),
    onMobileDiagnosticsChange: vi.fn(),
    onPerformanceChange: vi.fn(),
    onZoomIndicatorChange: vi.fn(),
    onDisableViews: vi.fn(),
    onChooseMob: vi.fn(),
    onClearMobs: vi.fn(),
    onCancelSpawning: vi.fn(),
    onOpenConsole: vi.fn(),
    onOpenProgression: vi.fn(),
    onResetClassAbilityCooldowns: vi.fn()
  };
}
