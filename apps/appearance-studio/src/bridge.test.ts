import {
  TERRITORY_STRUCTURE_CATALOG,
  TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH,
  type TerritoryStructureCatalog,
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DUNGEON_CATALOG,
  INTERIOR_DATA_RELATIVE_DIR,
  ITEM_VARIANT_CATALOG,
  PROGRESSION_ICON_PRESENTATION_CATALOG,
  RUNTIME_PNG_PRESENTATION_CATALOG,
  appearanceAssetParts,
  bossAppearanceAssetKeys,
  type BossAppearanceCatalog,
  type DungeonCatalog,
  type DungeonDefinition,
  type PlayerAppearanceCatalog,
  type ProgressionIconPresentationCatalog,
  type RuntimePngPresentationCatalog
} from "@ash-atlas/shared";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
  APPEARANCE_CATALOG_RELATIVE_PATH,
  BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
  BOSS_APPEARANCE_CATALOG_RELATIVE_PATH,
  ITEM_VARIANT_CATALOG_RELATIVE_PATH,
  RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH,
  RUNTIME_PNG_PRESENTATION_RELATIVE_PATH,
  PROGRESSION_ICON_PRESENTATION_RELATIVE_PATH,
  createAppearanceStudioBridge,
  validateRepositoryAppearanceContent
} from "./bridge.js";
import type { InteriorCatalogSnapshot, StudioSession } from "./bridgeTypes.js";
import type { ModuleView } from "./interiorModules.js";
import {
  bumpInteriorRevisions,
  createInteriorSpace,
  interiorCatalogOf,
  interiorEditingView,
  interiorFromEditingView,
  nextRevision,
  takenInteriorIds
} from "./interiorStudioModel.js";
import {
  APPEARANCE_STUDIO_CONTRACT_VERSION,
  type AppearanceStudioDesktopController
} from "./desktopContracts.js";
import { APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH } from "./workspaceSafety.js";
import { runFlagPackCommand } from "../../../tools/flag-pack/flag-pack.js";

const execFileAsync = promisify(execFile);
const COMMITTED_INTERIOR_DIR = path.join(fileURLToPath(new URL("../../..", import.meta.url)), INTERIOR_DATA_RELATIVE_DIR);
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Appearance Studio local bridge", () => {
  it("saves canonical Flags definitions with workspace, CSRF, revision and missing-PNG guards", async () => {
    const fixture = await linkedFixture();
    await writeFile(path.join(fixture.worktree, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH), JSON.stringify(TERRITORY_STRUCTURE_CATALOG));
    for (const visual of Object.values(TERRITORY_STRUCTURE_CATALOG.packs.stock!.structures)) {
      for (const piece of visual!.pieces) {
        const destination = path.join(fixture.worktree, piece.asset);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(ONE_PIXEL_PNG, "base64"));
      }
    }
    const app = await createAppearanceStudioBridge({ repositoryRoot: fixture.worktree, serveUi: false, port: 5285 });
    try {
      const session = (await app.inject({ method: "GET", url: "/api/session" })).json<StudioSession>();
      const loaded = await app.inject({ method: "GET", url: "/api/territory-structures" });
      expect(loaded.statusCode).toBe(200);
      const catalog = loaded.json<{ catalog: TerritoryStructureCatalog }>().catalog;
      catalog.packs.stock!.structures.soft_flag!.root.scale = 0.5;
      catalog.structures.soft_flag!.interaction.height = 70;
      const payload = { catalog, expectedRevision: catalog.revision, expectedWorkspace: {
        worktreePath: session.workspace.worktreePath, branch: session.workspace.branch, commitSha: session.workspace.commitSha
      } };
      const denied = await app.inject({ method: "POST", url: "/api/territory-structures/publish", payload });
      expect(denied.statusCode).toBe(403);
      const wrongWorkspace = await app.inject({ method: "POST", url: "/api/territory-structures/publish", headers: mutationHeaders(session),
        payload: { ...payload, expectedWorkspace: { ...payload.expectedWorkspace, branch: "feature/other" } } });
      expect(wrongWorkspace.statusCode).toBe(409);
      const published = await app.inject({ method: "POST", url: "/api/territory-structures/publish", headers: mutationHeaders(session), payload });
      expect(published.statusCode).toBe(200);
      expect(published.json()).toMatchObject({ modifiedFiles: [TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH] });
      const disk = JSON.parse(await readFile(path.join(fixture.worktree, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH), "utf8")) as TerritoryStructureCatalog;
      expect(disk.packs.stock!.structures.soft_flag!.root.scale).toBe(0.5);
      expect(disk.structures.soft_flag!.interaction.height).toBe(70);
      const stale = await app.inject({ method: "POST", url: "/api/territory-structures/publish", headers: mutationHeaders(session), payload });
      expect(stale.statusCode).toBe(409);
      disk.packs.stock!.structures.soft_flag!.pieces[0]!.asset = "apps/client/src/assets/flags/missing.png";
      const missing = await app.inject({ method: "POST", url: "/api/territory-structures/publish", headers: mutationHeaders(session),
        payload: { ...payload, catalog: disk, expectedRevision: disk.revision } });
      expect(missing.statusCode).toBe(400);
      expect(missing.body).toContain("missing PNG");
      const beforeClone = await readFile(path.join(fixture.worktree, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH), "utf8");
      expect(await runFlagPackCommand(["validate"], fixture.worktree)).toContain("all required types/roles");
      expect(await runFlagPackCommand(["clone", "--id", "violet", "--name", "Violet Banner", "--cloth-color", "#9933cc"], fixture.worktree)).toContain("Dry run");
      expect(await readFile(path.join(fixture.worktree, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH), "utf8")).toBe(beforeClone);
      expect(await runFlagPackCommand(["clone", "--id", "violet", "--name", "Violet Banner", "--cloth-color", "#9933cc", "--write"], fixture.worktree)).toContain("Created violet");
      const withPack = JSON.parse(await readFile(path.join(fixture.worktree, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH), "utf8")) as TerritoryStructureCatalog;
      expect(Object.keys(withPack.packs.violet!.structures)).toHaveLength(4);
      expect(withPack.packs.violet!.structures.soft_flag!.pieces[1]).toMatchObject({ role: "cloth", tint: "fixed", tintColor: "#9933cc" });
      expect(withPack.defaultPackId).toBe("stock");
      expect(withPack.structures).toEqual(disk.structures);
      expect(withPack.revision).toBe(disk.revision + 1);
      await expect(runFlagPackCommand(["clone", "--id", "violet", "--name", "Duplicate", "--write"], fixture.worktree)).rejects.toThrow("already exists");
      withPack.packs.violet!.structures.soft_flag!.pieces[0]!.role = "decoration";
      const invalidRole = await app.inject({ method: "POST", url: "/api/territory-structures/publish", headers: mutationHeaders(session),
        payload: { ...payload, catalog: withPack, expectedRevision: withPack.revision } });
      expect(invalidRole.statusCode).toBe(400);
      expect(invalidRole.body).toContain("visible hardware");
    } finally { await app.close(); }
  });
  it("keeps the feature worktree active after commit so integration remains available", async () => {
    const fixture = await linkedFixture({ contractVersion: 48 });
    const requestWorkspaceSwitch = vi.fn();
    const desktop: AppearanceStudioDesktopController = {
      appVersion: "1.48.0",
      createContentBatch: vi.fn(),
      finishContentBatch: vi.fn().mockResolvedValue({
        branch: "feature/appearance--from-t399",
        commitSha: "a".repeat(40),
        changedFiles: ["apps/client/src/assets/iron-bar.png"],
        pushed: true
      }),
      releaseStatus: vi.fn(),
      integrateContentBatch: vi.fn(),
      publishIntegrationTest: vi.fn(),
      openExternal: vi.fn(),
      requestWorkspaceSwitch
    };
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      desktop
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const response = await app.inject({
      method: "POST",
      url: "/api/desktop/finish-batch",
      headers: mutationHeaders(session),
      payload: { summary: "publish item scale" }
    });
    expect(response.statusCode).toBe(200);
    expect(desktop.finishContentBatch).toHaveBeenCalledWith({ summary: "publish item scale" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(requestWorkspaceSwitch).not.toHaveBeenCalled();
    await app.close();
  });

  it("publishes validated progression icon transforms and rejects stale or changed key sets", async () => {
    const fixture = await linkedFixture();
    const app = await createAppearanceStudioBridge({ repositoryRoot: fixture.worktree, serveUi: false, port: 5285 });
    const session = (await app.inject({ method: "GET", url: "/api/session" })).json<StudioSession>();
    const inventory = await app.inject({ method: "GET", url: "/api/progression-icons" });
    expect(inventory.statusCode).toBe(200);
    const catalog = inventory.json<{ catalog: ProgressionIconPresentationCatalog }>().catalog;
    catalog.transforms["general:cleave"] = { offsetX: 0.1, offsetY: -0.2, scale: 1.25 };
    const payload = {
      catalog,
      expectedRevision: catalog.revision,
      expectedWorkspace: {
        worktreePath: session.workspace.worktreePath,
        branch: session.workspace.branch,
        commitSha: session.workspace.commitSha
      }
    };
    const expectedPublishedRevision = catalog.revision + 1;
    const published = await app.inject({ method: "POST", url: "/api/progression-icons/publish", headers: mutationHeaders(session), payload });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      catalog: { revision: expectedPublishedRevision, transforms: { "general:cleave": payload.catalog.transforms["general:cleave"] } },
      modifiedFiles: [PROGRESSION_ICON_PRESENTATION_RELATIVE_PATH]
    });
    const stale = await app.inject({ method: "POST", url: "/api/progression-icons/publish", headers: mutationHeaders(session), payload });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe("CATALOG_REVISION_CONFLICT");
    const changedKeys = structuredClone(published.json<{ catalog: ProgressionIconPresentationCatalog }>().catalog);
    delete changedKeys.transforms["general:cleave"];
    const invalid = await app.inject({
      method: "POST", url: "/api/progression-icons/publish", headers: mutationHeaders(session),
      payload: { ...payload, catalog: changedKeys, expectedRevision: changedKeys.revision }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ code: string }>().code).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("inventories, stages, and atomically publishes runtime PNG presentation edits", async () => {
    const fixture = await linkedFixture();
    const discoveredAssetId = "apps/client/src/assets/future/nested-artwork.png";
    const discoveredAssetPath = path.join(fixture.worktree, discoveredAssetId);
    await mkdir(path.dirname(discoveredAssetPath), { recursive: true });
    await writeFile(discoveredAssetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const inventoryResponse = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(inventoryResponse.statusCode).toBe(200);
    expect(inventoryResponse.json<{ assets: Array<{ id: string }> }>().assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "apps/client/src/assets/deer.png" }),
        expect.objectContaining({ id: discoveredAssetId })
      ])
    );

    const discoveredReplacement = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/replace",
      headers: mutationHeaders(session),
      payload: {
        assetId: discoveredAssetId,
        fileName: "nested-artwork.png",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(discoveredReplacement.statusCode).toBe(200);

    const replacement = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/replace",
      headers: mutationHeaders(session),
      payload: {
        assetId: "apps/client/src/assets/deer.png",
        fileName: "deer.png",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(replacement.statusCode).toBe(200);
    const stagedInventory = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(stagedInventory.json<{ assets: Array<{ id: string; staged: boolean }> }>().assets)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "apps/client/src/assets/deer.png", staged: true })
      ]));

    const presentation = structuredClone(
      RUNTIME_PNG_PRESENTATION_CATALOG
    ) as RuntimePngPresentationCatalog;
    presentation.sprites.deer!.baseHeightPx = 88;
    presentation.sprites.deer!.horizontalScale = 1.25;
    presentation.sprites.deer!.minHeightPx = 22;
    presentation.sprites.deer!.maxHeightPx = null;
    presentation.sprites.deer!.hitGeometry = {
      shape: "rectangle",
      centerX: 0.48,
      centerY: 0.52,
      width: 0.72,
      height: 0.81
    };
    const published = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/publish",
      headers: mutationHeaders(session),
      payload: {
        presentation,
        expectedPresentationRevision: presentation.revision,
        expectedWorkspace: {
          worktreePath: session.workspace.worktreePath,
          branch: session.workspace.branch,
          commitSha: session.workspace.commitSha
        }
      }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      presentation: {
        revision: presentation.revision + 1,
        sprites: { deer: { baseHeightPx: 88, horizontalScale: 1.25, hitGeometry: presentation.sprites.deer!.hitGeometry } }
      },
      modifiedFiles: [RUNTIME_PNG_PRESENTATION_RELATIVE_PATH]
    });
    const saved = JSON.parse(await readFile(
      path.join(fixture.worktree, RUNTIME_PNG_PRESENTATION_RELATIVE_PATH),
      "utf8"
    )) as typeof presentation;
    expect(saved.sprites.deer).toMatchObject({
      baseHeightPx: 88,
      horizontalScale: 1.25,
      hitGeometry: presentation.sprites.deer!.hitGeometry
    });
    await app.close();
  });

  it("surfaces AtlasPNGS additions and explicitly stages them without overwriting the source", async () => {
    const fixture = await linkedFixture();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "ash-atlas-png-inbox-"));
    createdRoots.push(sourceRoot);
    const sourcePath = path.join(sourceRoot, "WildFlax.png");
    const sourceBytes = Buffer.from(ONE_PIXEL_PNG, "base64");
    await writeFile(sourcePath, sourceBytes);
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      atlasPngSourceRoot: sourceRoot,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();

    const discovered = await app.inject({ method: "GET", url: "/api/runtime-assets/inbox" });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toMatchObject({
      sourceDirectory: sourceRoot,
      entries: [expect.objectContaining({
        sourceFile: "WildFlax.png",
        label: "Wild Flax",
        destinationFile: "apps/client/src/assets/wild-flax.png",
        status: "ready",
        width: 1,
        height: 1
      })]
    });

    const imported = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/inbox/import",
      headers: mutationHeaders(session),
      payload: { sourceFile: "WildFlax.png" }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      sourceFile: "WildFlax.png",
      assetKey: "apps/client/src/assets/wild-flax.png"
    });
    expect((await app.inject({ method: "GET", url: "/api/runtime-assets" })).json<{
      assets: Array<{ id: string; staged: boolean }>;
    }>().assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "apps/client/src/assets/wild-flax.png", staged: true })
    ]));
    expect((await app.inject({ method: "GET", url: "/api/runtime-assets/inbox" })).json<{
      entries: Array<{ sourceFile: string; status: string }>;
    }>().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: "WildFlax.png", status: "staged" })
    ]));

    const presentation = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    const published = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/publish",
      headers: mutationHeaders(session),
      payload: {
        presentation,
        expectedPresentationRevision: presentation.revision,
        expectedWorkspace: {
          worktreePath: session.workspace.worktreePath,
          branch: session.workspace.branch,
          commitSha: session.workspace.commitSha
        }
      }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json<{ modifiedFiles: string[] }>().modifiedFiles)
      .toContain("apps/client/src/assets/wild-flax.png");
    expect(await readFile(path.join(fixture.worktree, "apps/client/src/assets/wild-flax.png")))
      .toEqual(sourceBytes);
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    expect((await app.inject({ method: "GET", url: "/api/runtime-assets/inbox" })).json<{
      entries: Array<{ sourceFile: string; status: string }>;
    }>().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: "WildFlax.png", status: "imported" })
    ]));
    await app.close();
  });

  it("blocks ambiguous AtlasPNGS filenames instead of choosing a target", async () => {
    const fixture = await linkedFixture();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "ash-atlas-png-inbox-"));
    createdRoots.push(sourceRoot);
    await writeFile(path.join(sourceRoot, "WildFlax.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await writeFile(path.join(sourceRoot, "wild_flax.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      atlasPngSourceRoot: sourceRoot,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const inbox = await app.inject({ method: "GET", url: "/api/runtime-assets/inbox" });
    expect(inbox.json<{ entries: Array<{ status: string }> }>().entries)
      .toEqual([
        expect.objectContaining({ status: "conflict" }),
        expect.objectContaining({ status: "conflict" })
      ]);
    const imported = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/inbox/import",
      headers: mutationHeaders(session),
      payload: { sourceFile: "WildFlax.png" }
    });
    expect(imported.statusCode).toBe(409);
    expect(imported.json<{ code: string }>().code).toBe("INBOX_IMPORT_CONFLICT");
    await app.close();
  });

  it("inventories every registered military slot and uploads directly to its canonical path", async () => {
    const fixture = await linkedFixture();
    const barracksAssetId = "apps/client/src/assets/structures/barracks.png";
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const inventory = (await app.inject({ method: "GET", url: "/api/runtime-assets" }))
      .json<{ assets: Array<{ id: string; label: string; missing: boolean; usages: unknown[] }> }>();
    expect(inventory.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/infantry.png",
        label: "Melee Kippin",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/archer.png",
        label: "Archer",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/bomber.png",
        label: "Bomber",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/field-ballista-crew.png",
        label: "Siege",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/war-camp.png",
        label: "War Camp",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/fusion-count-badge.png",
        label: "Fusion Count Badge",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/siege-packed.png",
        label: "Kippen Siege · Mobile / Idle",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/siege-deployed.png",
        label: "Kippen Siege · Deployed / Loading",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/siege-launch.png",
        label: "Kippen Siege · Launch",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/bomber-idle.png",
        label: "Kippen Bomber · Idle",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/military/units/bomber-planting.png",
        label: "Kippen Bomber · Planting",
        missing: true
      }),
      expect.objectContaining({
        id: barracksAssetId,
        label: "Barracks",
        missing: true,
        usages: [expect.objectContaining({
          editor: { kind: "world-object", key: "cityStructures.barracks" }
        })]
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/structures/armory.png",
        label: "Armory",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/structures/siege-workshop.png",
        label: "Siege Workshop",
        missing: true
      }),
      expect.objectContaining({
        id: "apps/client/src/assets/structures/powder-works.png",
        label: "Powder Works",
        missing: true
      })
    ]));
    expect((await app.inject({
      method: "GET",
      url: `/runtime-assets/${barracksAssetId}`
    })).statusCode).toBe(404);

    const siegePackedAssetId = "apps/client/src/assets/military/units/siege-packed.png";
    const stagedKippenSlot = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/replace",
      headers: mutationHeaders(session),
      payload: {
        assetId: siegePackedAssetId,
        fileName: "siege-packed.png",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(stagedKippenSlot.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/runtime-assets" }))
      .json<{ assets: Array<{ id: string; label: string; missing: boolean; staged: boolean }> }>().assets)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: siegePackedAssetId,
          label: "Kippen Siege · Mobile / Idle",
          missing: false,
          staged: true
        })
      ]));

    const staged = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/replace",
      headers: mutationHeaders(session),
      payload: {
        assetId: barracksAssetId,
        fileName: "barracks.png",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(staged.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/runtime-assets" }))
      .json<{ assets: Array<{ id: string; missing: boolean; staged: boolean }> }>().assets)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: barracksAssetId, missing: false, staged: true })
      ]));

    const presentation = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    const published = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/publish",
      headers: mutationHeaders(session),
      payload: {
        presentation,
        expectedPresentationRevision: presentation.revision,
        expectedWorkspace: {
          worktreePath: session.workspace.worktreePath,
          branch: session.workspace.branch,
          commitSha: session.workspace.commitSha
        }
      }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json<{ modifiedFiles: string[] }>().modifiedFiles)
      .toContain(barracksAssetId);
    expect(await readFile(path.join(fixture.worktree, barracksAssetId)))
      .toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));
    await app.close();
  });

  it("maps AtlasPNGS Loom art to the missing canonical Loom slot", async () => {
    const fixture = await linkedFixture();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "ash-atlas-loom-inbox-"));
    createdRoots.push(sourceRoot);
    const sourcePath = path.join(sourceRoot, "Loom.png");
    const sourceBytes = Buffer.from(ONE_PIXEL_PNG, "base64");
    await writeFile(sourcePath, sourceBytes);
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      atlasPngSourceRoot: sourceRoot,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const loomAssetId = "apps/client/src/assets/structures/loom.png";
    const inventory = (await app.inject({ method: "GET", url: "/api/runtime-assets" }))
      .json<{ assets: Array<{ id: string; label: string; missing: boolean; usages: unknown[] }> }>();
    expect(inventory.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: loomAssetId,
        label: "Loom",
        missing: true,
        usages: [expect.objectContaining({
          editor: { kind: "world-object", key: "loom" }
        })]
      })
    ]));

    const inbox = (await app.inject({ method: "GET", url: "/api/runtime-assets/inbox" }))
      .json<{ entries: Array<{ sourceFile: string; destinationFile: string; status: string }> }>();
    expect(inbox.entries).toEqual([{
      sourceFile: "Loom.png",
      label: "Loom",
      destinationFile: loomAssetId,
      width: 1,
      height: 1,
      bytes: sourceBytes.length,
      contentHash: expect.any(String),
      id: "Loom.png",
      status: "ready",
      statusReason: null
    }]);

    const imported = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/inbox/import",
      headers: mutationHeaders(session),
      payload: { sourceFile: "Loom.png" }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json<{ assetKey: string }>()).toMatchObject({ assetKey: loomAssetId });
    expect((await app.inject({ method: "GET", url: "/api/runtime-assets" }))
      .json<{ assets: Array<{ id: string; missing: boolean; staged: boolean }> }>().assets)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: loomAssetId, missing: false, staged: true })
      ]));

    const presentation = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    const published = await app.inject({
      method: "POST",
      url: "/api/runtime-assets/publish",
      headers: mutationHeaders(session),
      payload: {
        presentation,
        expectedPresentationRevision: presentation.revision,
        expectedWorkspace: {
          worktreePath: session.workspace.worktreePath,
          branch: session.workspace.branch,
          commitSha: session.workspace.commitSha
        }
      }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json<{ modifiedFiles: string[] }>().modifiedFiles).toContain(loomAssetId);
    expect(await readFile(path.join(fixture.worktree, loomAssetId))).toEqual(sourceBytes);
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    await app.close();
  });

  it("falls back safely when live runtime PNG metadata is absent", async () => {
    const fixture = await linkedFixture();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const response = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ assets: Array<{
      id: string;
      label: string;
      category: string;
      usages: Array<{ editor: { key?: string } }>;
    }> }>().assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "apps/client/src/assets/deer.png",
        label: "Deer",
        category: "Mobs & Animals",
        usages: [expect.objectContaining({ editor: { kind: "sprite", key: "deer" } })]
      })
    ]));
    await app.close();
  });

  it("reloads live runtime PNG metadata and overrides legacy inventory fields", async () => {
    const fixture = await linkedFixture();
    const metadataPath = path.join(fixture.worktree, RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH);
    await writeFile(metadataPath, `${JSON.stringify(runtimeMetadata({
      label: "Forest Deer",
      category: "Wildlife",
      usages: [{
        id: "production-deer",
        label: "Forest Deer",
        context: "Production renderer",
        editor: { kind: "sprite", key: "deer" }
      }]
    }), null, 2)}\n`);
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const first = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(first.json<{ assets: Array<{ id: string; label: string; category: string }> }>().assets)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: "apps/client/src/assets/deer.png",
        label: "Forest Deer",
        category: "Wildlife"
      })]));

    await writeFile(metadataPath, `${JSON.stringify(runtimeMetadata({ label: "Live Deer" }), null, 2)}\n`);
    const refreshed = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(refreshed.json<{ assets: Array<{ id: string; label: string }> }>().assets)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: "apps/client/src/assets/deer.png",
        label: "Live Deer"
      })]));
    await app.close();
  });

  it("rejects malformed, unsafe, and misbound runtime PNG metadata clearly", async () => {
    const fixture = await linkedFixture();
    const metadataPath = path.join(fixture.worktree, RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH);
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });

    await writeFile(metadataPath, "{not-json\n");
    const malformed = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json<{ error: string }>().error).toContain("contains invalid JSON");

    await writeFile(metadataPath, `${JSON.stringify({
      schemaVersion: 1,
      assets: { "apps/client/src/assets/../secret.png": { label: "Unsafe" } }
    })}\n`);
    const unsafe = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(unsafe.statusCode).toBe(500);
    expect(unsafe.json<{ error: string }>().error).toContain("not a canonical runtime PNG path");

    await writeFile(metadataPath, `${JSON.stringify(runtimeMetadata({
      usages: [{
        id: "wrong-editor",
        label: "Wrong Editor",
        context: "Production renderer",
        editor: { kind: "sprite", key: "not-a-presentation-key" }
      }]
    }))}\n`);
    const misbound = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(misbound.statusCode).toBe(500);
    expect(misbound.json<{ error: string }>().error).toContain("is not in the sprite presentation catalog");

    await writeFile(metadataPath, `${JSON.stringify(runtimeMetadata({
      usages: [{
        id: "wrong-zoom-mode",
        label: "Tannery",
        context: "World renderer",
        editor: { kind: "fixed", key: "tannery" }
      }]
    }))}\n`);
    const wrongZoomMode = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(wrongZoomMode.statusCode).toBe(500);
    expect(wrongZoomMode.json<{ error: string }>().error).toContain("must use the world-object editor");
    await app.close();
  });

  it("serves exact live construction, mob, and building production metadata", async () => {
    const fixture = await linkedFixture();
    const sourceMetadata = fileURLToPath(new URL(
      "../../../packages/shared/src/data/runtime-png-asset-metadata.json",
      import.meta.url
    ));
    await writeFile(
      path.join(fixture.worktree, RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH),
      await readFile(sourceMetadata)
    );
    for (const fileName of ["blueprint.png", "foundation.png", "framing.png"]) {
      const assetPath = path.join(
        fixture.worktree,
        "apps/client/src/assets/city-construction",
        fileName
      );
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
    }
    for (const fileName of [
      "goblin-basic.png",
      "goblin-warrior.png",
      "goblin-archer.png",
      "goblin-healer.png",
      "goblin-hall.png",
      "goblin-market.png"
    ]) {
      const assetPath = path.join(
        fixture.worktree,
        "apps/client/src/assets/goblins",
        fileName
      );
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
    }
    for (const relativeFile of [
      "apps/client/src/assets/coastal-crab.png",
      "apps/client/src/assets/sulfur-mine.png",
      "apps/client/src/assets/wild-flax.png"
    ]) {
      const assetPath = path.join(fixture.worktree, relativeFile);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
    }
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const response = await app.inject({ method: "GET", url: "/api/runtime-assets" });
    expect(response.statusCode).toBe(200);
    const construction = response.json<{ assets: Array<{
      id: string;
      label: string;
      category: string;
      usages: Array<{ editor: { kind: string; key: string } }>;
    }> }>().assets.filter((asset) => asset.id.includes("/city-construction/"));
    expect(construction).toEqual([
      expect.objectContaining({ label: "City Blueprint", category: "Buildings" }),
      expect.objectContaining({ label: "City Foundation", category: "Buildings" }),
      expect.objectContaining({ label: "City Framing", category: "Buildings" })
    ]);
    for (const asset of construction) {
      expect(asset.usages).toEqual([expect.objectContaining({
        context: "Production renderer",
        editor: { kind: "sprite", key: "city" }
      })]);
    }
    const goblins = response.json<{ assets: Array<{
      id: string;
      label: string;
      category: string;
      usages: Array<{ context: string; editor: { kind: string; key: string } }>;
    }> }>().assets.filter((asset) => asset.id.includes("/goblins/"));
    expect(goblins.map((asset) => ({
      label: asset.label,
      category: asset.category,
      context: asset.usages[0]?.context,
      editor: asset.usages[0]?.editor
    }))).toEqual([
      { label: "Goblin Hall", category: "Buildings", context: "World City Hall", editor: { kind: "sprite", key: "goblinHall" } },
      { label: "Goblin Market", category: "Buildings", context: "World City Facility", editor: { kind: "world-object", key: "cityStructures.goblin_market" } },
      { label: "Goblin", category: "Mobs & Animals", context: "World Mob", editor: { kind: "sprite", key: "goblinBasic" } },
      { label: "Goblin Archer", category: "Mobs & Animals", context: "World Mob", editor: { kind: "sprite", key: "goblinArcher" } },
      { label: "Goblin Healer", category: "Mobs & Animals", context: "World Mob", editor: { kind: "sprite", key: "goblinHealer" } },
      { label: "Goblin Warrior", category: "Mobs & Animals", context: "World Mob", editor: { kind: "sprite", key: "goblinWarrior" } }
    ]);
    const assets = response.json<{ assets: Array<{
      id: string;
      label: string;
      category: string;
      usages: Array<{ context: string; editor: { kind: string; key: string } }>;
    }> }>().assets;
    expect(assets.find((asset) => asset.id.endsWith("/coastal-crab.png")))
      .toMatchObject({
        label: "Coastal Crab",
        category: "Mobs & Animals",
        usages: [{ context: "World Mob", editor: { kind: "sprite", key: "coastalCrab" } }]
      });
    expect(assets.find((asset) => asset.id.endsWith("/wild-flax.png")))
      .toMatchObject({
        label: "Wild Flax",
        category: "Resources",
        usages: [{ context: "World Resource", editor: { kind: "sprite", key: "flax" } }]
      });
    expect(assets.find((asset) => asset.id.endsWith("/sulfur-mine.png")))
      .toMatchObject({
        label: "Sulfur Mine",
        category: "Resources",
        usages: [{ context: "World Resource", editor: { kind: "sprite", key: "sulfurMine" } }]
      });
    await app.close();
  });

  it("stages PNGs and publishes a linked item variant, appearance, and changed-file list", async () => {
    const fixture = await linkedFixture();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/session"
    });
    expect(sessionResponse.statusCode).toBe(200);
    const session = sessionResponse.json<StudioSession>();
    expect(session.workspace.writesAllowed).toBe(true);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: {
        origin: "https://attacker.example",
        "x-appearance-studio-token": session.csrfToken
      },
      payload: {
        fileName: "Sword.png",
        category: "weapons",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(rejected.statusCode).toBe(403);

    const imported = await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(session),
      payload: {
        fileName: "Ember.png",
        category: "weapons",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      assetKey: "weapons/ember.png",
      width: 1,
      height: 1
    });
    const projectileImported = await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(session),
      payload: {
        fileName: "Ember Arrow.png",
        category: "projectiles",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(projectileImported.statusCode).toBe(200);
    expect(projectileImported.json()).toMatchObject({
      assetKey: "projectiles/ember-arrow.png",
      width: 1,
      height: 1
    });

    const stagedFile = path.join(
      fixture.worktree,
      APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
      "weapons/ember.png"
    );
    await expect(readFile(stagedFile)).rejects.toThrow();
    const stagedProjectileFile = path.join(
      fixture.worktree,
      APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
      "projectiles/ember-arrow.png"
    );
    await expect(readFile(stagedProjectileFile)).rejects.toThrow();

    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances = [{
      appearanceId: "ember_sword",
      displayName: "Ember Sword",
      familyId: "one_handed_sword",
      assetKey: "weapons/ember.png",
      projectileAssetKey: "projectiles/ember-arrow.png",
      cosmetic: false,
      compatibleEquipmentDefinitionIds: ["starter_sword"]
    }];
    const itemVariants = {
      schemaVersion: 2 as const,
      variants: [{
        definitionId: "ember_sword",
        displayName: "Ember Sword",
        familyId: "sword" as const,
        role: "cosmetic" as const,
        appearanceId: "ember_sword"
      }]
    };
    const saved = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, catalog, itemVariants)
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().catalog.catalogRevision).toBe(
      DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision + 1
    );
    const onDisk = await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    );
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(onDisk.indexOf("\"appearances\"")).toBeLessThan(
      onDisk.indexOf("\"bodyVariants\"")
    );
    expect(JSON.parse(await readFile(
      path.join(fixture.worktree, ITEM_VARIANT_CATALOG_RELATIVE_PATH),
      "utf8"
    )).variants).toEqual(itemVariants.variants);
    expect(await readFile(stagedFile)).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));
    expect(await readFile(stagedProjectileFile)).toEqual(
      Buffer.from(ONE_PIXEL_PNG, "base64")
    );
    expect(saved.json().modifiedFiles).toEqual([
      APPEARANCE_CATALOG_RELATIVE_PATH,
      `${APPEARANCE_ASSET_ROOT_RELATIVE_PATH}/projectiles/ember-arrow.png`,
      `${APPEARANCE_ASSET_ROOT_RELATIVE_PATH}/weapons/ember.png`,
      ITEM_VARIANT_CATALOG_RELATIVE_PATH
    ].sort());

    const traversal = await app.inject({
      method: "GET",
      url: "/appearance-assets/%2e%2e%2foutside.png"
    });
    expect([400, 404]).toContain(traversal.statusCode);
    await app.close();
  });

  it("publishes an official boss weapon and its Idle, Ready, and Attack placements", async () => {
    const fixture = await linkedFixture();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const loaded = await app.inject({ method: "GET", url: "/api/boss-catalog" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json<BossAppearanceCatalog>().bosses[0]?.bossId).toBe("xoral");

    const imported = await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(session),
      payload: {
        fileName: "Xoral Blade.png",
        category: "weapons",
        assetScope: "boss",
        bossId: "xoral",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      assetKey: "xoral/weapons/xoral-blade.png",
      relativeFile:
        `${BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH}/xoral/weapons/xoral-blade.png`
    });

    const bossCatalog = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    bossCatalog.bosses[0]!.weapon = {
      assetKey: "xoral/weapons/xoral-blade.png",
      placements: {
        idle: { offsetX: 4 },
        combat_ready: { rotationDegrees: -35 },
        attack_action: { rotationDegrees: 70 }
      }
    };
    const saved = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(
        session,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        ITEM_VARIANT_CATALOG,
        bossCatalog
      )
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().catalog.catalogRevision)
      .toBe(DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision);
    expect(saved.json().bossCatalog.catalogRevision)
      .toBe(DEFAULT_BOSS_APPEARANCE_CATALOG.catalogRevision + 1);
    expect(saved.json().modifiedFiles).toEqual([
      BOSS_APPEARANCE_CATALOG_RELATIVE_PATH,
      `${BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH}/xoral/weapons/xoral-blade.png`
    ].sort());
    const onDisk = JSON.parse(await readFile(
      path.join(fixture.worktree, BOSS_APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    )) as BossAppearanceCatalog;
    expect(onDisk.bosses[0]?.weapon.placements.attack_action?.rotationDegrees).toBe(70);
    await app.close();
  });

  it("keeps Player saves working for a legacy worktree without boss content", async () => {
    const fixture = await linkedFixture();
    await rm(path.join(fixture.worktree, BOSS_APPEARANCE_CATALOG_RELATIVE_PATH));
    await rm(path.join(fixture.worktree, BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH), {
      recursive: true,
      force: true
    });
    await writeFile(
      path.join(fixture.worktree, APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH),
      '{"contractVersion":7,"minimumDesktopVersion":"1.7.0"}\n'
    );
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances[0]!.displayName = "Legacy Player Edit";
    const saved = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, catalog, ITEM_VARIANT_CATALOG)
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().modifiedFiles).toEqual([APPEARANCE_CATALOG_RELATIVE_PATH]);
    await expect(readFile(
      path.join(fixture.worktree, BOSS_APPEARANCE_CATALOG_RELATIVE_PATH)
    )).rejects.toThrow();
    await app.close();
  });

  it("preserves contract-15 catalogs without requiring or writing enhancement content", async () => {
    const fixture = await linkedFixture({
      contractVersion: 15,
      legacyEnhancements: true
    });
    await expect(validateRepositoryAppearanceContent(fixture.worktree)).resolves.toBeUndefined();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const loaded = (await app.inject({ method: "GET", url: "/api/catalog" }))
      .json<PlayerAppearanceCatalog>();

    const enhancementEdit = structuredClone(loaded);
    enhancementEdit.appearances[0]!.gemSocket = { partId: "main", x: 0.5, y: 0.5 };
    const rejected = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, enhancementEdit, ITEM_VARIANT_CATALOG)
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ code: "WORKSPACE_CONTRACT_REQUIRED" });

    const ordinaryEdit = structuredClone(loaded);
    ordinaryEdit.appearances[0]!.displayName = "Legacy Appearance Edit";
    const saved = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, ordinaryEdit, ITEM_VARIANT_CATALOG)
    });
    expect(saved.statusCode).toBe(200);
    const onDisk = JSON.parse(await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    )) as Record<string, unknown>;
    expect(onDisk.enhancementPresentation).toBeUndefined();
    expect((onDisk.appearances as Array<Record<string, unknown>>)
      .every((appearance) => appearance.gemSocket === undefined)).toBe(true);
    expect((onDisk.appearances as Array<Record<string, unknown>>)[0]?.displayName)
      .toBe("Legacy Appearance Edit");
    await app.close();
  });

  it("opens and preserves contract-16 catalogs with the original six gemstones", async () => {
    const fixture = await linkedFixture({
      contractVersion: 16,
      legacyGemstones: true
    });
    await expect(validateRepositoryAppearanceContent(fixture.worktree)).resolves.toBeUndefined();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      port: 5285
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const loadedResponse = await app.inject({ method: "GET", url: "/api/catalog" });
    expect(loadedResponse.statusCode).toBe(200);
    const loaded = loadedResponse.json<PlayerAppearanceCatalog>();
    expect(loaded.enhancementPresentation.gemstoneAssetKeys.onyx)
      .toBe("enhancements/gems/onyx.png");

    loaded.appearances[0]!.displayName = "Contract 16 Appearance Edit";
    const saved = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, loaded, ITEM_VARIANT_CATALOG)
    });
    expect(saved.statusCode).toBe(200);
    const onDisk = JSON.parse(await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    )) as PlayerAppearanceCatalog;
    expect(Object.keys(onDisk.enhancementPresentation.gemstoneAssetKeys)).toEqual([
      "amethyst",
      "diamond",
      "emerald",
      "opal",
      "ruby",
      "sapphire"
    ]);
    expect(onDisk.appearances[0]?.displayName).toBe("Contract 16 Appearance Edit");
    await app.close();
  });

  it("leaves the prior catalog intact when atomic replacement is interrupted", async () => {
    const fixture = await linkedFixture();
    const original = await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    );
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      beforeCatalogReplace: async () => {
        throw new Error("simulated interruption");
      }
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const failed = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(
        session,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        ITEM_VARIANT_CATALOG
      )
    });
    expect(failed.statusCode).toBe(500);
    expect(await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    )).toBe(original);
    await app.close();
  });

  it("rolls back every destination when a multi-file publish is interrupted", async () => {
    const fixture = await linkedFixture();
    const catalogPath = path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH);
    const variantsPath = path.join(fixture.worktree, ITEM_VARIANT_CATALOG_RELATIVE_PATH);
    const originalCatalog = await readFile(catalogPath, "utf8");
    const originalVariants = await readFile(variantsPath, "utf8");
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      afterFileReplace: async (_relativeFile, index) => {
        if (index === 0) throw new Error("simulated crash after first replacement");
      }
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const imported = await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(session),
      payload: {
        fileName: "Interrupted.png",
        category: "weapons",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances.push({
      appearanceId: "interrupted_sword",
      displayName: "Interrupted Sword",
      familyId: "one_handed_sword",
      assetKey: imported.json<{ assetKey: string }>().assetKey,
      cosmetic: false,
      compatibleEquipmentDefinitionIds: ["starter_sword"]
    });
    const itemVariants = {
      ...structuredClone(ITEM_VARIANT_CATALOG),
      variants: [
        ...ITEM_VARIANT_CATALOG.variants,
        {
          definitionId: "interrupted_sword",
          displayName: "Interrupted Sword",
          familyId: "sword" as const,
          role: "cosmetic" as const,
          appearanceId: "interrupted_sword"
        }
      ]
    };

    const failed = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, catalog, itemVariants)
    });

    expect(failed.statusCode).toBe(500);
    expect(await readFile(catalogPath, "utf8")).toBe(originalCatalog);
    expect(await readFile(variantsPath, "utf8")).toBe(originalVariants);
    await expect(readFile(path.join(
      fixture.worktree,
      APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
      "weapons/interrupted.png"
    ))).rejects.toThrow();
    await app.close();
  });

  it("rejects stale catalog revisions and workspace identities", async () => {
    const fixture = await linkedFixture();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const staleRevision = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: {
        ...publishPayload(session, DEFAULT_PLAYER_APPEARANCE_CATALOG, ITEM_VARIANT_CATALOG),
        expectedCatalogRevision: session.workspace.catalogRevision - 1
      }
    });
    expect(staleRevision.statusCode).toBe(409);
    expect(staleRevision.json()).toMatchObject({ code: "CATALOG_REVISION_CONFLICT" });

    const staleWorkspace = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: {
        ...publishPayload(session, DEFAULT_PLAYER_APPEARANCE_CATALOG, ITEM_VARIANT_CATALOG),
        expectedWorkspace: {
          ...publishPayload(
            session,
            DEFAULT_PLAYER_APPEARANCE_CATALOG,
            ITEM_VARIANT_CATALOG
          ).expectedWorkspace,
          commitSha: "f".repeat(40)
        }
      }
    });
    expect(staleWorkspace.statusCode).toBe(409);
    expect(staleWorkspace.json()).toMatchObject({ code: "WORKSPACE_CHANGED" });
    await app.close();
  });

  it("keeps staged imports available across a bridge restart", async () => {
    const fixture = await linkedFixture();
    const first = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const firstSession = (await first.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const imported = await first.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(firstSession),
      payload: {
        fileName: "Restarted.png",
        category: "weapons",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    await first.close();

    const second = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const secondSession = (await second.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances.find(
      ({ equipmentDefinitionId }) => equipmentDefinitionId === "starter_sword"
    )!.assetKey = imported.json<{ assetKey: string }>().assetKey;
    const published = await second.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(secondSession),
      payload: publishPayload(secondSession, catalog, ITEM_VARIANT_CATALOG)
    });
    expect(published.statusCode).toBe(200);
    expect(await readFile(path.join(
      fixture.worktree,
      APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
      "weapons/restarted.png"
    ))).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));
    await second.close();
  });

  it("rejects an overlapping publish while the first save is in flight", async () => {
    const fixture = await linkedFixture();
    let releaseSave!: () => void;
    let signalEntered!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false,
      beforeCatalogReplace: async () => {
        signalEntered();
        await saveGate;
      }
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const firstSave = app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(
        session,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        ITEM_VARIANT_CATALOG
      )
    });
    await entered;
    const overlappingSave = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(
        session,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        ITEM_VARIANT_CATALOG
      )
    });
    expect(overlappingSave.statusCode).toBe(409);
    expect(overlappingSave.json()).toMatchObject({ code: "SAVE_IN_PROGRESS" });
    releaseSave();
    expect((await firstSave).statusCode).toBe(200);
    await app.close();
  });

  it("rejects invalid variant references before writing staged assets or catalogs", async () => {
    const fixture = await linkedFixture();
    const original = await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    );
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(session),
      payload: {
        fileName: "Invalid.png",
        category: "weapons",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: {
        ...publishPayload(
          session,
          DEFAULT_PLAYER_APPEARANCE_CATALOG,
          ITEM_VARIANT_CATALOG
        ),
        catalog: DEFAULT_PLAYER_APPEARANCE_CATALOG,
        itemVariants: {
          schemaVersion: 2,
          variants: [{
            definitionId: "invalid_sword",
            displayName: "Invalid Sword",
            familyId: "sword",
            role: "cosmetic",
            appearanceId: "missing_appearance"
          }]
        }
      }
    });
    expect(rejected.statusCode).toBe(400);
    expect(await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    )).toBe(original);
    await expect(readFile(path.join(
      fixture.worktree,
      APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
      "weapons/invalid.png"
    ))).rejects.toThrow();
    await app.close();
  });

  it("publishes updated art for an existing item without store or variant output", async () => {
    const fixture = await linkedFixture();
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    const imported = await app.inject({
      method: "POST",
      url: "/api/assets/import",
      headers: mutationHeaders(session),
      payload: {
        fileName: "Starter-Revised.png",
        category: "weapons",
        dataBase64: ONE_PIXEL_PNG
      }
    });
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const starter = catalog.appearances.find(
      ({ equipmentDefinitionId }) => equipmentDefinitionId === "starter_sword"
    )!;
    starter.assetKey = imported.json<{ assetKey: string }>().assetKey;
    const published = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(session, catalog, ITEM_VARIANT_CATALOG)
    });

    expect(published.statusCode).toBe(200);
    expect(published.json().modifiedFiles).toEqual([
      APPEARANCE_CATALOG_RELATIVE_PATH,
      `${APPEARANCE_ASSET_ROOT_RELATIVE_PATH}/weapons/starter-revised.png`
    ].sort());
    expect(JSON.parse(await readFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      "utf8"
    )).appearances.find(
      (appearance: { equipmentDefinitionId?: string }) =>
        appearance.equipmentDefinitionId === "starter_sword"
    ).assetKey).toBe("weapons/starter-revised.png");
    await app.close();
  });

  it("refuses catalog writes from a protected branch", async () => {
    const fixture = await linkedFixture();
    await git(fixture.worktree, ["checkout", "integration/test"]);
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" }))
      .json<StudioSession>();
    expect(session.workspace.writesAllowed).toBe(false);
    expect(session.workspace.writeBlockReason).toMatch(/Protected branch/u);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/publish",
      headers: mutationHeaders(session),
      payload: publishPayload(
        session,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        ITEM_VARIANT_CATALOG
      )
    });
    expect(rejected.statusCode).toBe(403);
    await app.close();
  });

  it("opens an incompatible worktree read-only", async () => {
    const fixture = await linkedFixture();
    const futureContractVersion = APPEARANCE_STUDIO_CONTRACT_VERSION + 1;
    await writeFile(
      path.join(fixture.worktree, APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH),
      `${JSON.stringify({
        contractVersion: futureContractVersion,
        minimumDesktopVersion: "99.0.0"
      })}\n`
    );
    await writeFile(
      path.join(fixture.worktree, APPEARANCE_CATALOG_RELATIVE_PATH),
      '{"catalogRevision":99,"appearances":[{"equipmentDefinitionId":"future_item"}]}\n'
    );
    const app = await createAppearanceStudioBridge({
      repositoryRoot: fixture.worktree,
      serveUi: false
    });
    const session = (await app.inject({ method: "GET", url: "/api/session" })).json<{
      workspace: {
        writesAllowed: boolean;
        writeBlockReason: string;
        compatibility: { compatible: boolean; contractVersion: number };
        catalogRevision: number;
      };
    }>();
    expect(session.workspace.writesAllowed).toBe(false);
    expect(session.workspace.compatibility).toMatchObject({
      compatible: false,
      contractVersion: futureContractVersion
    });
    expect(session.workspace.catalogRevision).toBe(99);
    expect(session.workspace.writeBlockReason).toContain(`contract ${futureContractVersion}`);
    const catalog = await app.inject({ method: "GET", url: "/api/catalog" });
    expect(catalog.statusCode).toBe(409);
    expect(catalog.json<{ error: string }>().error).toMatch(/update required/u);
    await app.close();
  });

  describe("unified interior catalog routes", () => {
    type Snapshot = InteriorCatalogSnapshot;
    const workspaceOf = (session: StudioSession) => ({
      worktreePath: session.workspace.worktreePath,
      branch: session.workspace.branch,
      commitSha: session.workspace.commitSha
    });
    async function openInteriorBridge(options: Partial<Parameters<typeof createAppearanceStudioBridge>[0]> = {}) {
      const fixture = await linkedFixture({ contractVersion: 20 });
      const app = await createAppearanceStudioBridge({ repositoryRoot: fixture.worktree, serveUi: false, port: 5285, ...options });
      const session = (await app.inject({ method: "GET", url: "/api/session" })).json<StudioSession>();
      const load = async (): Promise<Snapshot> => (await app.inject({ method: "GET", url: "/api/interior-catalog" })).json<Snapshot>();
      /** Edit the editing view of `spaceId`, bump revisions like the Studio does, and build the publish body. */
      const editPayload = (snapshot: Snapshot, spaceId: string, edit: (definition: DungeonDefinition, view: DungeonCatalog) => void, options: { bump?: boolean } = {}) => {
        const base = interiorCatalogOf(snapshot);
        const view = interiorEditingView(base);
        edit(view.dungeons.find((definition) => definition.id === spaceId)!, view);
        const assembled = interiorFromEditingView(base, {}, view);
        const proposed = options.bump === false ? assembled : bumpInteriorRevisions(base, assembled);
        return {
          space: proposed.spaces.find((space) => space.id === spaceId)!,
          library: proposed.library,
          expectedCatalogRevision: snapshot.catalogRevision,
          expectedSpaceRevisions: { [spaceId]: snapshot.spaceRevisions[spaceId] ?? null },
          expectedWorkspace: workspaceOf(session)
        };
      };
      const publish = (spaceId: string, payload: unknown) => app.inject({
        method: "POST",
        url: `/api/interior-catalog/${spaceId}/publish`,
        headers: mutationHeaders(session),
        payload: payload as Record<string, unknown>
      });
      return { app, session, fixture, load, editPayload, publish };
    }
    const spaceText = (fixture: { worktree: string }, fileName: string) => readFile(path.join(fixture.worktree, INTERIOR_DATA_RELATIVE_DIR, fileName), "utf8");

    it("loads the library and every space with the catalog revision and per-space revisions", async () => {
      const { app, load } = await openInteriorBridge();
      const snapshot = await load();
      expect(snapshot.catalogRevision).toBe(snapshot.library.catalogRevision);
      expect(snapshot.spaces.map((space) => space.kind)).toEqual(expect.arrayContaining(["dungeon", "manor", "greenhouse"]));
      for (const space of snapshot.spaces) expect(snapshot.spaceRevisions[space.id]).toBe(space.revision);
      expect(snapshot.library.prefabs.length).toBeGreaterThan(0);
      await app.close();
    });

    it("publishes a changed space of every kind, bumping the catalog revision and writing only that space", async () => {
      const { app, fixture, load, editPayload, publish } = await openInteriorBridge();
      for (const [spaceId, kind] of [["manor_lobby", "manor"], ["greenhouse", "greenhouse"], ["cistern_warrens", "dungeon"]] as const) {
        const before = await load();
        expect(before.spaces.find((space) => space.id === spaceId)!.kind).toBe(kind);
        const result = await publish(spaceId, editPayload(before, spaceId, (definition) => { definition.rooms[0]!.name = `${definition.rooms[0]!.name} Renamed`; }));
        expect(result.statusCode, result.body).toBe(200);
        const body = result.json<Snapshot & { modifiedFiles: string[] }>();
        expect(body.catalogRevision).toBe(before.catalogRevision + 1);
        expect(body.spaceRevisions[spaceId]).not.toBe(before.spaceRevisions[spaceId]);
        expect(body.modifiedFiles).toEqual(expect.arrayContaining([`${INTERIOR_DATA_RELATIVE_DIR}/${spaceId}.json`, `${INTERIOR_DATA_RELATIVE_DIR}/_library.json`]));
        expect(body.modifiedFiles.filter((file) => file.endsWith(".json") && !file.endsWith("_library.json"))).toEqual([`${INTERIOR_DATA_RELATIVE_DIR}/${spaceId}.json`]);
        expect(JSON.parse(await spaceText(fixture, `${spaceId}.json`)).rooms[0].name).toContain("Renamed");
        expect((await load()).catalogRevision).toBe(before.catalogRevision + 1);
      }
      await app.close();
    });

    it("returns unchanged content without writing anything", async () => {
      const { app, load, editPayload, publish } = await openInteriorBridge();
      const before = await load();
      const result = await publish("manor_lobby", editPayload(before, "manor_lobby", () => undefined));
      expect(result.statusCode).toBe(200);
      expect(result.json<{ modifiedFiles: string[]; catalogRevision: number }>()).toMatchObject({ modifiedFiles: [], catalogRevision: before.catalogRevision });
      await app.close();
    });

    it("refuses a save made against an older catalog or space revision", async () => {
      const { app, load, editPayload, publish } = await openInteriorBridge();
      const before = await load();
      const stale = editPayload(before, "greenhouse", (definition) => { definition.name = "Greenhouse Two"; });
      expect((await publish("greenhouse", stale)).statusCode).toBe(200);
      const conflict = await publish("greenhouse", stale);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json<{ code: string }>().code).toBe("CATALOG_REVISION_CONFLICT");
      const after = await load();
      const wrongSpace = editPayload(after, "greenhouse", (definition) => { definition.name = "Greenhouse Three"; });
      wrongSpace.expectedSpaceRevisions = { greenhouse: before.spaceRevisions.greenhouse! };
      const spaceConflict = await publish("greenhouse", wrongSpace);
      expect(spaceConflict.statusCode).toBe(409);
      expect(spaceConflict.json<{ code: string }>().code).toBe("SPACE_REVISION_CONFLICT");
      await app.close();
    });

    it("refuses to delete published ids (retire instead)", async () => {
      const { app, load, editPayload, publish } = await openInteriorBridge();
      const before = await load();
      const anchorId = before.spaces.find((space) => space.id === "manor_lobby")!.rooms[0]!.anchors.find((anchor) => anchor.role === "point")!.id;
      const removed = await publish("manor_lobby", editPayload(before, "manor_lobby", (definition) => {
        definition.rooms[0]!.anchors = definition.rooms[0]!.anchors.filter((anchor) => anchor.id !== anchorId);
      }));
      expect(removed.statusCode).toBe(400);
      expect(removed.json<{ code: string }>().code).toBe("STABLE_ID_DELETION");
      const roomRemoved = await publish("greenhouse", editPayload(before, "greenhouse", (definition) => {
        definition.rooms = [];
      }));
      expect(roomRemoved.statusCode).toBe(400);
      await app.close();
    });

    it("refuses changed rooms and spaces that keep their revision, for every kind", async () => {
      const { app, load, editPayload, publish } = await openInteriorBridge();
      const before = await load();
      for (const spaceId of ["manor_lobby", "greenhouse", "cistern_warrens"]) {
        const result = await publish(spaceId, editPayload(before, spaceId, (definition) => { definition.rooms[0]!.name = "Same Revision"; }, { bump: false }));
        expect(result.statusCode, spaceId).toBe(400);
        expect(result.json<{ code: string }>().code).toBe("INTERIOR_REVISION_ID_REQUIRED");
      }
      // Manor also needs a new published revision identity, not only a new revision.
      const manorPayload = editPayload(before, "manor_lobby", (definition) => { definition.rooms[0]!.name = "Half Bumped"; });
      manorPayload.space = { ...manorPayload.space, publishedRevisionId: before.spaces.find((space) => space.id === "manor_lobby")!.publishedRevisionId };
      const halfBumped = await publish("manor_lobby", manorPayload);
      expect(halfBumped.statusCode).toBe(400);
      expect(halfBumped.json<{ code: string }>().code).toBe("INTERIOR_REVISION_ID_REQUIRED");
      await app.close();
    });

    it("creates a new space through the same publish and refuses to create it twice", async () => {
      const { app, session, load, publish } = await openInteriorBridge();
      const before = await load();
      const view = interiorEditingView(interiorCatalogOf(before));
      const space = createInteriorSpace("salon", "Second Salon", before.library, takenInteriorIds(interiorCatalogOf(before), view));
      const payload = { space, expectedCatalogRevision: before.catalogRevision, expectedSpaceRevisions: { [space.id]: null }, expectedWorkspace: workspaceOf(session) };
      const created = await publish(space.id, payload);
      expect(created.statusCode, created.body).toBe(200);
      expect((await load()).spaces.map((candidate) => candidate.id)).toContain(space.id);
      const index = await readFile(path.join(session.workspace.worktreePath, INTERIOR_DATA_RELATIVE_DIR, "index.ts"), "utf8");
      expect(index).toContain(`${space.id}.json`);
      const again = await publish(space.id, { ...payload, expectedCatalogRevision: before.catalogRevision + 1 });
      expect(again.statusCode).toBe(409);
      expect(again.json<{ code: string }>().code).toBe("SPACE_REVISION_CONFLICT");
      const mismatch = await publish("another_space", { ...payload, expectedCatalogRevision: before.catalogRevision + 1 });
      expect(mismatch.statusCode).toBe(400);
      await app.close();
    });

    it("validates dungeon spaces catalog-wide before saving", async () => {
      const { app, load, editPayload, publish } = await openInteriorBridge();
      const before = await load();
      const invalid = await publish("cistern_warrens", editPayload(before, "cistern_warrens", (definition) => {
        definition.encounters[0]!.roomId = "no_such_room";
      }));
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<{ code: string }>().code).toBe("INTERIOR_CATALOG_INVALID");
      expect((await load()).catalogRevision).toBe(before.catalogRevision);
      await app.close();
    });

    it("publishes a Greenhouse template edit together with its staged runtime PNGs, and refuses unregistered ones", async () => {
      const { app, session, fixture, load, editPayload, publish } = await openInteriorBridge();
      const before = await load();
      const stage = async (assetId: string) => (await app.inject({
        method: "POST",
        url: "/api/runtime-assets/replace",
        headers: mutationHeaders(session),
        payload: { assetId, fileName: "replacement.png", dataBase64: ONE_PIXEL_PNG }
      })).json<{ stagingToken: string }>().stagingToken;
      const potPath = "apps/client/src/assets/structures/greenhouse-pot.png";
      const treeStagePath = "apps/client/src/assets/plants/giving-berry-tree-fruiting.png";
      const tokens = [await stage(potPath), await stage(treeStagePath)];
      const potBefore = before.library.prefabs.find((prefab) => prefab.id === "greenhouse_pot")!;
      const payload = {
        ...editPayload(before, "greenhouse", (_definition, view) => {
          view.prefabs.find((prefab) => prefab.id === "greenhouse_pot")!.defaultWidth = potBefore.defaultWidth + 8;
        }),
        pendingAssetTokens: tokens
      };
      const published = await publish("greenhouse", payload);
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json<{ modifiedFiles: string[] }>().modifiedFiles).toEqual(expect.arrayContaining([potPath, treeStagePath, `${INTERIOR_DATA_RELATIVE_DIR}/greenhouse.json`, `${INTERIOR_DATA_RELATIVE_DIR}/_library.json`]));
      const saved = await load();
      expect(saved.library.prefabs.find((prefab) => prefab.id === "greenhouse_pot")!.defaultWidth).toBe(potBefore.defaultWidth + 8);
      expect(saved.spaceRevisions.greenhouse).not.toBe(before.spaceRevisions.greenhouse);
      expect(await readFile(path.join(fixture.worktree, potPath))).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));
      expect(await readFile(path.join(fixture.worktree, treeStagePath))).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));

      // Art with no catalog change still publishes (and bumps the catalog revision).
      const artOnly = await stage(potPath);
      const artPayload = { ...editPayload(saved, "greenhouse", () => undefined), pendingAssetTokens: [artOnly] };
      const artResult = await publish("greenhouse", artPayload);
      expect(artResult.statusCode, artResult.body).toBe(200);
      expect(artResult.json<{ modifiedFiles: string[]; catalogRevision: number }>()).toMatchObject({ modifiedFiles: expect.arrayContaining([potPath]), catalogRevision: saved.catalogRevision + 1 });

      // Only Dungeon, Manor and registered Greenhouse PNGs may ride along with an interior publish.
      const fresh = await load();
      const stagedElsewhere = await stage("apps/client/src/assets/deer.png");
      const refused = await publish("greenhouse", { ...editPayload(fresh, "greenhouse", () => undefined), pendingAssetTokens: [stagedElsewhere] });
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ code: string }>().code).toBe("INTERIOR_ASSET_TOKEN_INVALID");
      await app.close();
    });

    const stageDungeonPng = async (app: Awaited<ReturnType<typeof openInteriorBridge>>["app"], session: StudioSession, prefabId: string) => {
      const imported = await app.inject({ method: "POST", url: "/api/dungeon-assets/import", headers: mutationHeaders(session), payload: { fileName: `${prefabId}.png`, dataBase64: ONE_PIXEL_PNG, displayName: prefabId, prefabId, kind: "decoration", layer: "above_player", renderMode: "sprite", defaultWidth: 64, defaultHeight: 64 } });
      expect(imported.statusCode, imported.body).toBe(200);
      return imported.json<{ stagingToken: string; assetKey: string; width: number; height: number }>();
    };
    const dungeonPrefab = (id: string, assetKey: string) => ({ id, revision: `${id}-v1`, name: id, type: "decoration" as const, retired: false, defaultWidth: 64, defaultHeight: 64, defaultLayerId: "above_player" as const, assetKey, renderMode: "sprite" as const, nativeWidth: 1, nativeHeight: 1, pivotX: 0.5, pivotY: 1, defaultOpacity: 1, defaultRotationDeg: 0, defaultFlipX: false, defaultFlipY: false, stateAssets: [], defaultColliders: [] });

    it("stages and atomically publishes a new dungeon PNG with its prefab, refusing a token that was never staged", async () => {
      const { app, session, fixture, load, editPayload, publish } = await openInteriorBridge();
      const staged = await stageDungeonPng(app, session, "moss_floor");
      expect(staged).toMatchObject({ assetKey: "apps/client/public/assets/dungeons/custom/moss_floor.png", width: 1, height: 1 });
      const before = await load();
      const payload = { ...editPayload(before, "cistern_warrens", (_definition, view) => { view.prefabs.push(dungeonPrefab("moss_floor", staged.assetKey)); }), pendingAssetTokens: [staged.stagingToken] };
      const invalidToken = await publish("cistern_warrens", { ...payload, pendingAssetTokens: ["not-a-staged-token"] });
      expect(invalidToken.statusCode).toBe(400);
      expect(invalidToken.json<{ code: string }>().code).toBe("INTERIOR_ASSET_TOKEN_INVALID");
      const published = await publish("cistern_warrens", payload);
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json<{ modifiedFiles: string[] }>().modifiedFiles).toEqual(expect.arrayContaining([`${INTERIOR_DATA_RELATIVE_DIR}/_library.json`, staged.assetKey]));
      expect((await readFile(path.join(fixture.worktree, staged.assetKey))).toString("base64")).toBe(ONE_PIXEL_PNG);
      expect((await load()).library.prefabs.some((prefab) => prefab.id === "moss_floor")).toBe(true);
      await app.close();
    });

    it("rolls back a staged dungeon PNG and the catalog when the atomic publish is interrupted", async () => {
      const { app, session, fixture, load, editPayload, publish } = await openInteriorBridge({ afterFileReplace: async (_file, index) => { if (index === 0) throw new Error("interrupt interior publish"); } });
      const staged = await stageDungeonPng(app, session, "rune");
      const before = await load();
      const failed = await publish("cistern_warrens", { ...editPayload(before, "cistern_warrens", (_definition, view) => { view.prefabs.push(dungeonPrefab("rune", staged.assetKey)); }), pendingAssetTokens: [staged.stagingToken] });
      expect(failed.statusCode).toBe(500);
      await expect(readFile(path.join(fixture.worktree, staged.assetKey))).rejects.toThrow();
      const after = await load();
      expect(after.catalogRevision).toBe(before.catalogRevision);
      expect(after.library.prefabs.some((prefab) => prefab.id === "rune")).toBe(false);
      await app.close();
    });

    it("publishes a Studio-authored Manor decoration and its staged PNG atomically", async () => {
      const { app, session, fixture, load, editPayload, publish } = await openInteriorBridge();
      const imported = await app.inject({ method: "POST", url: "/api/manor-assets/import", headers: mutationHeaders(session), payload: { fileName: "reading-lamp.png", dataBase64: ONE_PIXEL_PNG } });
      expect(imported.statusCode, imported.body).toBe(200);
      const staged = imported.json<{ stagingToken: string; assetKey: string }>();
      expect((await app.inject({ method: "GET", url: `/runtime-assets/${staged.assetKey}` })).rawPayload).toEqual(Buffer.from(ONE_PIXEL_PNG, "base64"));
      const before = await load();
      const stored = before.spaces.find((space) => space.id === "manor_lobby")!;
      const roomId = stored.rooms[0]!.id;
      const definitions = stored.modules!.decoration!.definitions;
      const surfaceId = definitions[0]?.surfaceId ?? "floor_surface";
      const payload = {
        ...editPayload(before, "manor_lobby", (_definition, view) => {
          (view as ModuleView).interiorModules = { manor_lobby: { decorations: [...definitions, {
            id: "reading_lamp", retired: false, name: "Reading Lamp", itemId: "wood", assetKey: staged.assetKey, roomId, surfaceId,
            layer: "in_front", placementMode: "movable",
            transform: { x: 627, y: 700, width: 64, height: 64, rotationDeg: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
            footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], collision: false, zIndex: 0, mirrorX: false
          }] } };
        }),
        pendingAssetTokens: [staged.stagingToken]
      };
      const published = await publish("manor_lobby", payload);
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json<{ modifiedFiles: string[] }>().modifiedFiles).toEqual(expect.arrayContaining([`${INTERIOR_DATA_RELATIVE_DIR}/manor_lobby.json`, staged.assetKey]));
      expect((await readFile(path.join(fixture.worktree, staged.assetKey))).toString("base64")).toBe(ONE_PIXEL_PNG);
      const saved = (await load()).spaces.find((space) => space.id === "manor_lobby")!;
      expect(saved.modules!.decoration!.definitions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "reading_lamp", itemId: "wood", placementMode: "movable" })]));
      await app.close();
    });

    it("publishes an uploaded Manor floor PNG through the same atomic asset transaction", async () => {
      const { app, session, fixture, load, editPayload, publish } = await openInteriorBridge();
      const imported = await app.inject({ method: "POST", url: "/api/manor-assets/import", headers: mutationHeaders(session), payload: { fileName: "hallway.png", dataBase64: ONE_PIXEL_PNG } });
      expect(imported.statusCode, imported.body).toBe(200);
      const staged = imported.json<{ stagingToken: string; assetKey: string }>();
      const before = await load();
      const stored = before.spaces.find((space) => space.id === "manor_lobby")!;
      const payload = { ...editPayload(before, "manor_lobby", () => undefined, { bump: false }), pendingAssetTokens: [staged.stagingToken] };
      payload.space = { ...stored, environment: { ...stored.environment, floorAssetKey: staged.assetKey }, revision: nextRevision(stored.revision), publishedRevisionId: nextRevision(stored.publishedRevisionId!) };
      const result = await publish("manor_lobby", payload);
      expect(result.statusCode, result.body).toBe(200);
      expect((await readFile(path.join(fixture.worktree, staged.assetKey))).toString("base64")).toBe(ONE_PIXEL_PNG);
      expect((await load()).spaces.find((space) => space.id === "manor_lobby")!.environment.floorAssetKey).toBe(staged.assetKey);
      await app.close();
    });

    it("rejects an interior publish from another origin", async () => {
      const { app, session, load, editPayload } = await openInteriorBridge();
      const before = await load();
      const rejected = await app.inject({
        method: "POST",
        url: "/api/interior-catalog/cistern_warrens/publish",
        headers: { ...mutationHeaders(session), origin: "http://127.0.0.1:5286" },
        payload: editPayload(before, "cistern_warrens", (definition) => { definition.description = "Cross-origin edit."; })
      });
      expect(rejected.statusCode).toBe(403);
      expect((await load()).catalogRevision).toBe(before.catalogRevision);
      await app.close();
    });

    it("saves several spaces atomically when a shared library change touches them", async () => {
      const { app, session, load } = await openInteriorBridge();
      const before = await load();
      const base = interiorCatalogOf(before);
      const view = interiorEditingView(base);
      view.dungeons.find((definition) => definition.id === "cistern_warrens")!.description = "Changed together.";
      view.dungeons.find((definition) => definition.id === "greenhouse")!.description = "Changed together too.";
      const proposed = bumpInteriorRevisions(base, interiorFromEditingView(base, {}, view));
      const result = await app.inject({
        method: "POST",
        url: "/api/interior-catalog/cistern_warrens/publish",
        headers: mutationHeaders(session),
        payload: {
          space: proposed.spaces.find((space) => space.id === "cistern_warrens"),
          alsoSpaces: [proposed.spaces.find((space) => space.id === "greenhouse")],
          library: proposed.library,
          expectedCatalogRevision: before.catalogRevision,
          expectedSpaceRevisions: { cistern_warrens: before.spaceRevisions.cistern_warrens, greenhouse: before.spaceRevisions.greenhouse },
          expectedWorkspace: workspaceOf(session)
        }
      });
      expect(result.statusCode, result.body).toBe(200);
      const after = await load();
      expect(after.catalogRevision).toBe(before.catalogRevision + 1);
      expect(after.spaces.find((space) => space.id === "greenhouse")!.description).toBe("Changed together too.");
      await app.close();
    });
  });
});

function mutationHeaders(session: { csrfToken: string; origin: string }) {
  return {
    origin: session.origin,
    "x-appearance-studio-token": session.csrfToken
  };
}

function publishPayload(
  session: StudioSession,
  catalog: PlayerAppearanceCatalog,
  itemVariants: unknown,
  bossCatalog: BossAppearanceCatalog = DEFAULT_BOSS_APPEARANCE_CATALOG
) {
  return {
    catalog,
    bossCatalog,
    itemVariants,
    expectedCatalogRevision: session.workspace.catalogRevision,
    expectedBossCatalogRevision: bossCatalog.catalogRevision,
    expectedWorkspace: {
      worktreePath: session.workspace.worktreePath,
      branch: session.workspace.branch,
      commitSha: session.workspace.commitSha
    }
  };
}

function runtimeMetadata(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    assets: {
      "apps/client/src/assets/deer.png": entry
    }
  };
}

async function linkedFixture(options: {
  contractVersion?: number;
  legacyEnhancements?: boolean;
  legacyGemstones?: boolean;
} = {}): Promise<{ worktree: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ash-appearance-studio-"));
  createdRoots.push(root);
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(
    repository,
    path.dirname(APPEARANCE_CATALOG_RELATIVE_PATH)
  ), { recursive: true });
  await mkdir(path.join(
    repository,
    path.dirname(APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH)
  ), { recursive: true });
  await mkdir(path.join(repository, APPEARANCE_ASSET_ROOT_RELATIVE_PATH), {
    recursive: true
  });
  await mkdir(path.join(repository, BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH), {
    recursive: true
  });
  const playerCatalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
  if (options.legacyEnhancements) {
    delete (playerCatalog as unknown as Record<string, unknown>).enhancementPresentation;
    for (const appearance of playerCatalog.appearances) {
      delete (appearance as unknown as Record<string, unknown>).gemSocket;
    }
  }
  if (options.legacyGemstones) {
    const keys = playerCatalog.enhancementPresentation.gemstoneAssetKeys as unknown as
      Record<string, string>;
    delete keys.onyx;
    delete keys.topaz;
  }
  await writeFile(
    path.join(repository, APPEARANCE_CATALOG_RELATIVE_PATH),
    `${JSON.stringify(playerCatalog, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, ITEM_VARIANT_CATALOG_RELATIVE_PATH),
    `${JSON.stringify(ITEM_VARIANT_CATALOG, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, BOSS_APPEARANCE_CATALOG_RELATIVE_PATH),
    `${JSON.stringify(DEFAULT_BOSS_APPEARANCE_CATALOG, null, 2)}\n`
  );
  await mkdir(path.join(repository, INTERIOR_DATA_RELATIVE_DIR), { recursive: true });
  // The committed interior data: one file per space plus the shared library and index.
  await cp(COMMITTED_INTERIOR_DIR, path.join(repository, INTERIOR_DATA_RELATIVE_DIR), { recursive: true });
  await writeFile(
    path.join(repository, RUNTIME_PNG_PRESENTATION_RELATIVE_PATH),
    `${JSON.stringify(RUNTIME_PNG_PRESENTATION_CATALOG, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, PROGRESSION_ICON_PRESENTATION_RELATIVE_PATH),
    `${JSON.stringify(PROGRESSION_ICON_PRESENTATION_CATALOG, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH),
    `${JSON.stringify({
      contractVersion: options.contractVersion ?? 18,
      minimumDesktopVersion: options.contractVersion === 15
        ? "1.15.0"
        : options.contractVersion === 16
          ? "1.16.0"
          : options.contractVersion === 17
            ? "1.17.0"
            : options.contractVersion === 18
              ? "1.18.0"
              : "1.19.0"
    }, null, 2)}\n`
  );
  for (const assetKey of new Set([
    ...DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.flatMap((appearance) =>
      appearanceAssetParts(appearance).map((part) => part.assetKey)
    ),
    ...DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.flatMap((appearance) =>
      appearance.projectileAssetKey ? [appearance.projectileAssetKey] : []
    ),
    ...DEFAULT_PLAYER_APPEARANCE_CATALOG.bodyVariants.flatMap((body) =>
      [
        ...Object.values(body.bodyAssetKeys ?? {}),
        ...Object.values(body.skinToneAssetKeys ?? {})
      ]
        .filter((key): key is string => typeof key === "string")
    ),
    ...(options.legacyEnhancements ? [] : Object.values(
      playerCatalog.enhancementPresentation.gemstoneAssetKeys
    ))
  ])) {
    const assetPath = path.join(repository, APPEARANCE_ASSET_ROOT_RELATIVE_PATH, assetKey);
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
  }
  for (const assetKey of bossAppearanceAssetKeys(DEFAULT_BOSS_APPEARANCE_CATALOG)) {
    const assetPath = path.join(
      repository,
      BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
      assetKey
    );
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
  }
  for (const assetKey of new Set(DUNGEON_CATALOG.prefabs.map((prefab) => prefab.assetKey))) {
    const assetPath = path.join(repository, assetKey);
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, Buffer.from(ONE_PIXEL_PNG, "base64"));
  }
  await writeFile(
    path.join(repository, APPEARANCE_ASSET_ROOT_RELATIVE_PATH, ".gitkeep"),
    ""
  );
  const manorDecorationAsset = path.join(
    repository,
    "apps/client/public/assets/manor/simpledoublebed.png"
  );
  await mkdir(path.dirname(manorDecorationAsset), { recursive: true });
  await writeFile(manorDecorationAsset, Buffer.from(ONE_PIXEL_PNG, "base64"));
  const runtimeAsset = path.join(repository, "apps/client/src/assets/deer.png");
  await mkdir(path.dirname(runtimeAsset), { recursive: true });
  await writeFile(runtimeAsset, Buffer.from(ONE_PIXEL_PNG, "base64"));
  const manorFloorAsset = path.join(
    repository,
    "apps/client/src/assets/structures/manor-floor.png"
  );
  await mkdir(path.dirname(manorFloorAsset), { recursive: true });
  await writeFile(manorFloorAsset, Buffer.from(ONE_PIXEL_PNG, "base64"));
  // The seeded Manor types reference their floor and building PNGs.
  for (const type of ["timber", "samurai", "haunted"]) {
    for (const name of ["exterior", "lobby", "hall", "room", "room-left", "lower"]) {
      const asset = path.join(repository, `apps/client/src/assets/manors/${type}/${name}.png`);
      await mkdir(path.dirname(asset), { recursive: true });
      await writeFile(asset, Buffer.from(ONE_PIXEL_PNG, "base64"));
    }
  }
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "studio@example.com"]);
  await git(repository, ["config", "user.name", "Studio Test"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "test fixture"]);
  await git(repository, ["branch", "integration/test"]);
  await git(repository, [
    "worktree",
    "add",
    "-b",
    "feature/studio-test",
    worktree
  ]);
  return { worktree };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
