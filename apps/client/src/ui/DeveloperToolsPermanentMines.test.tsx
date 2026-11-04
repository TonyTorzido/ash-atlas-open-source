// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperToolsPanel } from "./DeveloperToolsPanel.js";

describe("Developer Tools permanent mines", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads materialized mines and has no legacy pet debug surface", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      mines: [{
        id: "11111111-1111-4111-8111-111111111119",
        lat: 35.1,
        lon: -106.6,
        state: "ready",
        canonicalState: "ready",
        canonicalLifecycleValid: false,
        projectionState: "ready",
        canonicalRevision: 8,
        projectionRevision: 8,
        harvestRevision: 8,
        lifecycleMismatch: true,
        remainingMs: 0,
        placementBucketKey: "stone-mine-geography-v1:1:2",
        placementVersion: "stone-mine-geography-v1",
        regionCode: "NM",
        worldPackageId: "world-nm",
        worldEcoregion: "Chihuahuan",
        coveringFlag: { id: "flag-1", name: "Mesa", distanceM: 300 },
        coveringFlagCount: 1
      }],
      total: 1
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onVisitMine = vi.fn();
    render(
      <DeveloperToolsPanel
        {...baseProps()}
        serverHttpBase="http://localhost"
        onVisitMine={onVisitMine}
      />
    );

    expect(screen.queryByRole("button", { name: "Pet Debug" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Permanent Mines" }));
    expect(await screen.findByText("11111111-1111-4111-8111-111111111119")).toBeTruthy();
    expect(screen.getByText("Impossible canonical lifecycle")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Travel to Mine" }));
    expect(onVisitMine).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111119");
  });

  it("lists exact Goblin Village coordinates and delegates destructive intent", () => {
    const onRequestGoblinVillages = vi.fn();
    const onDeleteGoblinVillage = vi.fn();
    const village = {
      cityId: "11111111-1111-4111-8111-111111111111",
      name: "Goblin Village",
      hallLat: 35.084412345,
      hallLon: -106.650498765,
      flagCount: 19,
      createdAt: "2026-08-30T12:00:00.000Z"
    };
    const view = render(<DeveloperToolsPanel
      {...baseProps()}
      goblinVillages={[village]}
      onRequestGoblinVillages={onRequestGoblinVillages}
      onDeleteGoblinVillage={onDeleteGoblinVillage}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Spawning" }));
    expect(screen.getByText("35.084412345, -106.650498765")).toBeTruthy();
    expect(onRequestGoblinVillages).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteGoblinVillage).toHaveBeenCalledWith(village);

    view.rerender(<DeveloperToolsPanel
      {...baseProps()}
      goblinVillages={[village]}
      goblinVillageDeleteBusy
      onRequestGoblinVillages={onRequestGoblinVillages}
      onDeleteGoblinVillage={onDeleteGoblinVillage}
    />);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function baseProps(): ComponentProps<typeof DeveloperToolsPanel> {
  return {
    open: true,
    developerAccessEnabled: true,
    worldMutationEnabled: true,
    inventory: {
      playerId: "p",
      revision: 0,
      items: [],
      totals: {
        wood: 0,
        stone: 0,
        coal: 0,
        iron: 0,
        sulfur: 0,
        iron_bar: 0,
        venomsteel_bar: 0,
        venomsteel_core: 0,
        fire_feather: 0, tempest_quill: 0, ice_feather: 0,
        fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
        food: 0,
        ore: 0,
        water: 0,
        leather: 0,
        deer_hide: 0,
        hog_hide: 0,
        wolf_pelt: 0,
        bear_hide: 0,
        alligator_hide: 0,
        squid_flesh: 0,
        crab_carapace: 0,
        raw_meat: 0,
        shell: 0,
      giving_berry: 0,
      balsam_resin: 0,
      crude_oil: 0,
      jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
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
    zoomIndicatorAvailable: true,
    activeArchetype: null,
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
