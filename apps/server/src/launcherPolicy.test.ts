import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cmd = readFileSync(`${root}Run Ash Atlas.cmd`, "utf8");
const launcher = readFileSync(`${root}tools/dev/run-main.ps1`, "utf8");
const runtimeLibrary = readFileSync(`${root}tools/dev/runtime-lib.ps1`, "utf8");
const worldRuntimeGroups = readFileSync(`${root}tools/dev/world-runtime-groups.ps1`, "utf8");
const featureRuntime = readFileSync(`${root}tools/dev/feature-runtime.ps1`, "utf8");
const stopLauncher = readFileSync(`${root}tools/dev/stop-main.ps1`, "utf8");
const compose = readFileSync(`${root}docker-compose.yml`, "utf8");
const defaults = JSON.parse(readFileSync(`${root}config/dev-runtime.defaults.json`, "utf8")) as {
  permanent_checkout: string;
  feature_launcher_root: string;
  main: {
    branch: string;
    compose_project: string;
    ports: { frontend: number; backend: number; world_api: number; postgres: number };
    database: { name: string; volume: string; retained: boolean };
  };
  feature: {
    database_prefix: string;
    port_pool: { start: number; end: number };
    world_api_group_port_pool: { start: number; end: number };
    lifecycle: { mutex_wait_seconds: number; shutdown_wait_seconds: number; poll_milliseconds: number };
  };
  water_name_index_root: string;
};
const worldRuntimeLock = JSON.parse(
  readFileSync(`${root}config/world-runtime.lock.json`, "utf8"),
) as {
  pipeline: { repository: string; protected_branch: string; sha: string };
  release: { release_id: string; manifest_sha256: string; package_count: number; artifact_count: number };
  lake_surface: {
    release_id: string;
    manifest_sha256: string;
    policy: string;
    membership_policy: string;
    overlap_policy: string;
    grid_fingerprint: string;
    cell_size_m: number;
    package_count: number;
    lake_count: number;
    cell_count: number;
    span_count: number;
  };
  ocean_coast_surface: {
    release_id: string; manifest_sha256: string; policy: string; selection_policy: string;
    band_morphology: string; band_cells: number; overlap_policy: string;
    precedence_policy: string; deep_ocean_policy: string; grid_fingerprint: string;
    cell_size_m: number; package_count: number; cell_count: number; span_count: number;
  };
  waterbody_identity_overlay: {
    release_id: string; manifest_sha256: string; schema: string; policy: string;
    package_count: number; source_cell_count: number; source_span_count: number;
    final_cell_count: number; final_span_count: number;
    identity_registry_fingerprint: string; deterministic_fingerprint: string;
    input_release_ids: { river: string; lake: string; ocean: string };
    input_manifests: { river: string; lake: string; ocean: string };
  };
  water_visual_tiles: {
    release_id: string; manifest_sha256: string; policy: string; precedence: string;
    surface_policy: string; freshwater_perimeter_policy: string;
    ocean_coastline_policy: string; deep_ocean_policy: string; layers: string[];
    min_zoom: number; max_zoom: number; artifact_file: string; artifact_sha256: string;
    artifact_size_bytes: number; tile_count: number;
  };
  settlement_authority: {
    release_id: string;
    release_fingerprint: string;
    settlement_count: number;
    alias_count: number;
  };
  water_name_index: {
    release_id: string;
    manifest_sha256: string;
    schema: string;
    policy: string;
    entries_filename: string;
    entries_format: string;
    entries_sha256: string;
    entries_size_bytes: number;
    index_hash: string;
    deterministic_fingerprint: string;
    entry_count: number;
    classes: { river: number; lake: number; ocean: number };
    max_distance_m: { river: number; lake: number; ocean: number };
  };
};

describe("canonical launcher policy", () => {
  it("keeps one root wrapper, passes arguments, pauses only on failure, and propagates the code", () => {
    expect(cmd).toContain("tools\\dev\\run-main.ps1\" %*");
    expect(cmd).toContain('set "ASH_ATLAS_EXIT=%ERRORLEVEL%"');
    expect(cmd).toContain('if not "%ASH_ATLAS_EXIT%"=="0"');
    expect(cmd).toContain("pause");
    expect(cmd).toContain("exit /b %ASH_ATLAS_EXIT%");
    expect(cmd.indexOf("pause")).toBeGreaterThan(cmd.indexOf('if not "%ASH_ATLAS_EXIT%"=="0"'));
  });

  it("loads canonical Main identity from one tracked defaults file", () => {
    expect(defaults.permanent_checkout).toBe("C:\\Users\\dev\\Documents\\game");
    expect(defaults.main).toMatchObject({
      branch: "master",
      compose_project: "ash-atlas",
      ports: { frontend: 5270, backend: 3000, world_api: 8765, postgres: 35432 },
      database: {
        name: "ash_atlas_game",
        volume: "ash-atlas_ash_atlas_game_postgres",
        retained: true,
      },
    });
    expect(launcher).toContain("Read-AshAtlasRuntimeDefaults");
    expect(launcher).not.toContain("$DatabasePort = 35432");
  });

  it("requires interpolated Compose identities and an external volume", () => {
    for (const variable of [
      "ASH_ATLAS_COMPOSE_PROJECT",
      "ASH_ATLAS_POSTGRES_CONTAINER",
      "ASH_ATLAS_POSTGRES_PORT",
      "ASH_ATLAS_DATABASE_NAME",
      "ASH_ATLAS_POSTGRES_VOLUME",
      "ASH_ATLAS_NETWORK_NAME",
      "ASH_ATLAS_RUNTIME_ID",
    ]) {
      expect(compose).toContain(`\${${variable}:?`);
    }
    expect(compose).toContain("external: true");
    expect(compose).not.toContain("container_name: ash-atlas-postgis");
    expect(compose).not.toContain("55432");
  });

  it("supports isolated feature identities and disposable stability databases", () => {
    expect(launcher).toContain("[ValidateSet('Main', 'Feature')]");
    expect(launcher).toContain("[string]$WorktreePath");
    expect(defaults.feature.database_prefix).toBe("ash_atlas_stability");
    expect(defaults.feature.port_pool).toEqual({ start: 41000, end: 41899, ports_per_runtime: 3 });
    expect(runtimeLibrary).toContain("Test-AshAtlasSafeFeatureRuntime");
    expect(runtimeLibrary).toContain("Feature runtime refused unsafe database identity");
    expect(defaults.feature_launcher_root).toBe(
      "C:\\Users\\dev\\Documents\\Ash Atlas Feature Launchers",
    );
    expect(defaults.water_name_index_root).toBe(
      "C:\\Users\\dev\\Documents\\water-names-v1",
    );
  });

  it("loads the world lock from the selected verified runtime worktree", () => {
    expect(launcher).toContain("Join-Path $Runtime.worktree 'config\\world-runtime.lock.json'");
    expect(launcher).not.toContain("Join-Path $SupervisorRoot 'config\\world-runtime.lock.json'");
    expect(launcher.indexOf("$runtime = Resolve-SelectedRuntime")).toBeLessThan(
      launcher.indexOf("Set-WorldRuntimePolicy $runtime"),
    );
    expect(launcher).toContain("Assert-ExactPath $SupervisorRoot");
    expect(launcher).toContain("Assert-ExactPath (Get-AshAtlasGitValue $root");
  });

  it("supports explicit generated-launcher lifecycle and verified post-merge cleanup", () => {
    expect(featureRuntime).toContain(
      "[ValidateSet('create', 'sync', 'status', 'ready', 'park', 'mark-merged', 'remove', 'cleanup')]",
    );
    expect(featureRuntime).toContain("New-AshAtlasFeatureLauncherContent");
    expect(featureRuntime).toContain("worktree', 'list', '--porcelain'");
    expect(featureRuntime).toContain("PreserveExistingPorts");
    expect(featureRuntime).toContain("merge-base --is-ancestor");
    expect(featureRuntime).toContain("'status', '--porcelain=v1', '--untracked-files=all'");
    expect(featureRuntime).toContain("'ls-files', '--others', '--exclude-standard'");
    expect(featureRuntime).toContain("worktree remove");
    expect(featureRuntime).toContain("branch --delete --force");
    expect(featureRuntime).toContain("push origin --delete");
    expect(featureRuntime).not.toMatch(/\bgit\s+merge\b/);
  });

  it("reuses healthy exact runtimes and coordinates bounded restart of unhealthy ones", () => {
    expect(defaults.feature.lifecycle).toEqual({
      max_running_features: 4,
      mutex_wait_seconds: 45,
      shutdown_wait_seconds: 30,
      poll_milliseconds: 250,
    });
    expect(launcher).toContain("Invoke-HealthyRuntimeReuse");
    expect(launcher).toContain("Runtime is already healthy; reusing it.");
    expect(launcher).toContain("Test-LiveRecordedRuntimeSupervisor");
    expect(launcher).toContain("Complete-RuntimeQuiescence");
    expect(launcher).toContain("supervisor.json");
    expect(launcher).toContain("start_time_utc");
    expect(launcher).toContain("Wait-RuntimeStopRequest");
    expect(launcher).not.toMatch(/WaitOne\(0\).+already active/s);
    expect(launcher).not.toContain("Read-Host");
    expect(runtimeLibrary).toContain("Enter-AshAtlasRuntimeLifecycleMutex");
    expect(runtimeLibrary).toContain("Wait-AshAtlasBoundedCondition");
    expect(worldRuntimeGroups).toContain("'--lake-surface-release-root'");
    expect(worldRuntimeGroups).toContain("'--lake-surface-manifest-sha256'");
    expect(worldRuntimeGroups).toContain("'--lake-surface-policy'");
    expect(worldRuntimeGroups).toContain("'--ocean-coast-surface-release-root'");
    expect(worldRuntimeGroups).toContain("'--ocean-coast-surface-manifest-sha256'");
    expect(worldRuntimeGroups).toContain("'--ocean-coast-surface-policy'");
    expect(worldRuntimeGroups).toContain("'--riverbank-lakeshore-release-root'");
    expect(worldRuntimeGroups).toContain("'--riverbank-lakeshore-manifest-sha256'");
    expect(worldRuntimeGroups).toContain("'--riverbank-lakeshore-policy'");
    expect(worldRuntimeGroups).toContain("'--water-name-index-root'");
    expect(worldRuntimeGroups).toContain("'--water-name-index-manifest-sha256'");
    expect(launcher).toContain("Assert-WaterVisualSourceIdentity");
    expect(launcher).toContain("ASH_ATLAS_WATER_VISUAL_TILES_PATH");
  });

  it("pins the protected pipeline and immutable release without weakening identity checks", () => {
    expect(worldRuntimeLock.pipeline).toEqual({
      repository: "example-org/world-data",
      protected_branch: "main",
      sha: "d2efd6b4966e25646f41f988ece6b6ef1c882bc5",
    });
    expect(worldRuntimeLock.release.release_id).toBe("world-packages-v1");
    expect(worldRuntimeLock.release.manifest_sha256).toBe(
      "80bfe7152f2b4f16cc182cc38a86a72950634d5799fbb31b6bad4ef686bb5578",
    );
    expect(worldRuntimeLock.release.package_count).toBe(64_800);
    expect(worldRuntimeLock.release.artifact_count).toBe(648_000);
    for (const retired of ["river_visual_tiles", "lake_visual_tiles", "ocean_coast_visual_tiles"]) {
      expect(worldRuntimeLock).not.toHaveProperty(retired);
    }
    expect(worldRuntimeLock.lake_surface).toEqual({
      release_id: "lake-surface-v1",
      manifest_sha256: "d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9",
      policy: "hydrolakes-center-membership-v1",
      membership_policy: "reconstructed-lake-covers-canonical-cell-center",
      overlap_policy: "independent-river-and-lake-memberships",
      grid_fingerprint: "44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b",
      cell_size_m: 125,
      package_count: 11_423,
      lake_count: 185_181,
      cell_count: 477_463_775,
      span_count: 18_044_558,
    });
    expect(worldRuntimeLock.ocean_coast_surface).toEqual({
      release_id: "ocean-coast-surface-v1",
      manifest_sha256: "b8319476532112ef6076d56819a89a9551ea88c4b55f52a06c80b8bae8fa3954",
      policy: "three-cell-canonical-ocean-coast-v1",
      selection_policy: "canonical-cell-center-outside-authoritative-land",
      band_morphology: "three-cell-chebyshev-dilation-v1",
      band_cells: 3,
      overlap_policy: "independent-river-lake-ocean-coast-memberships",
      precedence_policy: "river>lake>ocean>land",
      deep_ocean_policy: "implicit-outside-authoritative-land",
      grid_fingerprint: "44e1b2d53f5b3d38b6f5370d30c94403d6d4f90a6207f12ccdee799713a6229b",
      cell_size_m: 125,
      package_count: 6_929,
      cell_count: 99_447_307,
      span_count: 14_326_950,
    });
    expect(worldRuntimeLock.waterbody_identity_overlay).toEqual({
      release_id: "waterbody-identity-overlay-v4",
      manifest_sha256: "f81deb9fb441ec5644095b1d4ea8f430c652948f5e7a64e9beac5a6ea005020c",
      schema: "waterbody-identity-overlay-v1",
      schema_version: "waterbody-identity-overlay-v1",
      policy: "existing-cell-candidate-precedence-v1",
      policy_version: "existing-cell-candidate-precedence-v1",
      package_count: 17_109,
      source_cell_count: 677_287_350,
      source_span_count: 53_130_897,
      final_cell_count: 670_964_923,
      final_span_count: 53_334_150,
      identity_registry_fingerprint: "972e15ccc73c0364c5c49e9252ef7a0936d90b344dbeef74a8f53dde9576a6d2",
      deterministic_fingerprint: "3f78b03289beda4cb08068c490927df6f6f5583cabdbe7b906f2e047d0b2cb38",
      input_release_ids: {
        river: "river-surface-v1",
        lake: "lake-surface-v1",
        ocean: "ocean-coast-surface-v1",
      },
      input_manifests: {
        river: "c605631193ff786e33182fb8b6d7cfa3ab868b35d0a47fec5e1aa717ace447d5",
        lake: "d0c25c2b6a4e9349091a5f483a294fac7988cd098a1f77e354343cb2f27f42b9",
        ocean: "b8319476532112ef6076d56819a89a9551ea88c4b55f52a06c80b8bae8fa3954",
      },
    });
    expect(worldRuntimeLock.water_name_index).toEqual({
      release_id: "water-names-v1",
      manifest_sha256: "bb73ebeac7c48d4adcedf9dd10e9a0a6cf591bd8ef7dfe01dca2a141a9e6317b",
      schema: "water-names-v1",
      policy: "same-class-nearest-authoritative-name-v1",
      entries_filename: "entries.sqlite3",
      entries_format: "sqlite-wkb-rtree-v1",
      entries_sha256: "40dd4b1427c0fc98cdd437ea6dcdb2b2e4d8d5412af636159624e144b337fee9",
      entries_size_bytes: 2_295_668_736,
      index_hash: "90482d2633df3cc869e1c1162aa7b1da0503f051740122eeeb65612cd33c3bd2",
      deterministic_fingerprint: "41d3431fc3f87eb52b1219bccebc32228c6dd49e610f0194ea55c76c8c370661",
      entry_count: 526_218,
      classes: { river: 523_086, lake: 3_021, ocean: 111 },
      max_distance_m: { river: 25_000, lake: 100_000, ocean: 500_000 },
    });
    expect(worldRuntimeLock.water_visual_tiles).toEqual({
      release_id: "water-visual-tiles-v1",
      manifest_sha256: "6eece70668d929850944b44ccd134a426972080aeed18865f7c360618daeb229",
      policy: "precedence-resolved-canonical-water-visual-v1",
      precedence: "river>lake>ocean>land",
      surface_policy: "canonical-membership-geometric-difference",
      freshwater_perimeter_policy: "boundary-of-expanded-dissolved-visible-cell-mask",
      ocean_coastline_policy: "visible-ocean-grid-edges-adjacent-to-authoritative-land",
      deep_ocean_policy: "implicit-outside-authoritative-land",
      layers: [
        "water_ocean_surface",
        "water_ocean_coastline",
        "water_lake_surface",
        "water_lake_perimeter",
        "water_river_surface",
        "water_river_perimeter",
      ],
      min_zoom: 12,
      max_zoom: 14,
      artifact_file: "water-visual-7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a.pmtiles",
      artifact_sha256: "7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a",
      artifact_size_bytes: 1_639_576_487,
      tile_count: 8_290_747,
    });
    expect(worldRuntimeLock.settlement_authority).toEqual({
      release_id: "world-settlements-v2",
      release_fingerprint: "462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26",
      founding_policy_id: "settlement-founding-v2",
      founding_policy_fingerprint: "cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1",
      resolution_policy_id: "primary-settlement-resolution-v1",
      resolution_policy_fingerprint: "6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371",
      settlement_count: 3_345_617,
      alias_count: 3_350_348,
    });
    expect(worldRuntimeGroups).toContain(
      "[string]$Health.runtime.sha -cne [string]$Identity.pipeline.sha",
    );
    expect(worldRuntimeGroups).toContain(
      "[string]$Health.release_verification.release_manifest_sha256 -cne [string]$Identity.release.manifest_sha256",
    );
    expect(launcher).toContain("$hash -ne $ExpectedManifestSha256");
  });

  it("contains no destructive retained-volume or broad process commands", () => {
    const combined = `${launcher}\n${stopLauncher}`;
    expect(combined).not.toMatch(/docker compose down -v/i);
    expect(combined).not.toContain("Stop-Process -Name");
    expect(combined).not.toContain("taskkill");
    expect(launcher).toContain("Assert-RetainedVolume");
    expect(launcher).toContain("REFUSED: existing Main container mounts");
    expect(stopLauncher).toContain("-RuntimeMode Main -Stop");
  });
});
