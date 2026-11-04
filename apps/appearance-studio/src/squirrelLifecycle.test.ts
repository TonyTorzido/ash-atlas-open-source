import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cleanupSquirrelInstallation,
  squirrelInstallationPaths,
  squirrelLifecycleAction,
  type SquirrelCleanupFileSystem
} from "./squirrelLifecycle.js";

describe("Squirrel lifecycle argument handling", () => {
  it.each([
    ["--squirrel-install", "create"],
    ["--squirrel-updated", "create"],
    ["--squirrel-uninstall", "remove"],
    ["--squirrel-obsolete", null]
  ] as const)("maps %s to shortcut action %s wherever it appears", (event, shortcut) => {
    expect(squirrelLifecycleAction(["studio.exe", "--extra", event, "1.37.0"], "win32"))
      .toEqual({ event, shortcut });
  });

  it("ignores unsupported arguments and non-Windows launches", () => {
    expect(squirrelLifecycleAction(["studio.exe", "--squirrel-firstrun"], "win32"))
      .toBeNull();
    expect(squirrelLifecycleAction(["studio", "--squirrel-install"], "linux"))
      .toBeNull();
  });
});

describe("Squirrel installation cleanup", () => {
  it("selects the installed version from the executable path", () => {
    const installRoot = path.join("C:\\Users\\studio", "AppData", "Local", "AshAtlasStudio");
    expect(squirrelInstallationPaths(
      path.join(installRoot, "app-1.40.0", "AshAtlasAppearanceStudio.exe")
    )).toEqual({
      installRoot,
      currentAppDirectory: path.join(installRoot, "app-1.40.0"),
      currentVersion: "1.40.0",
      updateExecutable: path.join(installRoot, "Update.exe"),
      packagesDirectory: path.join(installRoot, "packages")
    });
    expect(squirrelInstallationPaths(path.join(installRoot, "AshAtlasAppearanceStudio.exe")))
      .toBeNull();
  });

  it("removes stale app directories and full packages while preserving the current install", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ash-atlas-studio-"));
    try {
      const currentApp = path.join(root, "app-1.40.0");
      const previousApp = path.join(root, "app-1.39.0");
      const packages = path.join(root, "packages");
      await mkdir(path.join(currentApp, "resources"), { recursive: true });
      await mkdir(previousApp, { recursive: true });
      await mkdir(packages, { recursive: true });
      await writeFile(path.join(root, "Update.exe"), "updater");
      await writeFile(path.join(currentApp, "AshAtlasAppearanceStudio.exe"), "current");
      await writeFile(path.join(previousApp, "AshAtlasAppearanceStudio.exe"), "previous");
      await writeFile(path.join(packages, "AshAtlasAppearanceStudio-1.40.0-full.nupkg"), "current");
      await writeFile(path.join(packages, "AshAtlasAppearanceStudio-1.39.0-full.nupkg"), "previous");
      await writeFile(path.join(packages, "AshAtlasAppearanceStudio-1.39.0-delta.nupkg"), "delta");
      await writeFile(path.join(packages, "AshAtlasAppearanceStudio-1.40.0-delta.nupkg"), "delta");
      const result = await cleanupSquirrelInstallation(
        path.join(currentApp, "AshAtlasAppearanceStudio.exe")
      );

      expect(result.currentVersion).toBe("1.40.0");
      expect(result.removedAppDirectories).toEqual([previousApp]);
      expect(result.removedFullPackages).toEqual([
        path.join(packages, "AshAtlasAppearanceStudio-1.39.0-full.nupkg")
      ]);
      expect(result.removedDeltaPackages).toEqual([
        path.join(packages, "AshAtlasAppearanceStudio-1.39.0-delta.nupkg"),
        path.join(packages, "AshAtlasAppearanceStudio-1.40.0-delta.nupkg")
      ]);
      await expect(access(currentApp)).resolves.toBeUndefined();
      await expect(access(path.join(root, "Update.exe"))).resolves.toBeUndefined();
      await expect(readFile(path.join(currentApp, "AshAtlasAppearanceStudio.exe"), "utf8"))
        .resolves.toBe("current");
      await expect(access(previousApp)).rejects.toThrow();
      await expect(access(path.join(packages, "AshAtlasAppearanceStudio-1.39.0-full.nupkg")))
        .rejects.toThrow();
      await expect(access(path.join(packages, "AshAtlasAppearanceStudio-1.40.0-full.nupkg")))
        .resolves.toBeUndefined();
      await expect(access(path.join(packages, "AshAtlasAppearanceStudio-1.39.0-delta.nupkg")))
        .rejects.toThrow();
      await expect(access(path.join(packages, "AshAtlasAppearanceStudio-1.40.0-delta.nupkg")))
        .rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains deltas while the current full package is not yet available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ash-atlas-studio-"));
    try {
      const currentApp = path.join(root, "app-1.40.2");
      const packages = path.join(root, "packages");
      const deltaPackage = path.join(packages, "AshAtlasAppearanceStudio-1.40.2-delta.nupkg");
      await mkdir(currentApp, { recursive: true });
      await mkdir(packages, { recursive: true });
      await writeFile(path.join(root, "Update.exe"), "updater");
      await writeFile(deltaPackage, "in-flight");

      const result = await cleanupSquirrelInstallation(
        path.join(currentApp, "AshAtlasAppearanceStudio.exe")
      );

      expect(result.removedDeltaPackages).toEqual([]);
      await expect(access(deltaPackage)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("contains cleanup failures so a locked old version cannot block startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ash-atlas-studio-"));
    try {
      const currentApp = path.join(root, "app-1.40.0");
      const previousApp = path.join(root, "app-1.39.0");
      const packages = path.join(root, "packages");
      await mkdir(currentApp, { recursive: true });
      await mkdir(previousApp, { recursive: true });
      await mkdir(packages, { recursive: true });
      await writeFile(path.join(root, "Update.exe"), "updater");
      await writeFile(path.join(packages, "AshAtlasAppearanceStudio-1.39.0-full.nupkg"), "previous");
      const errors: unknown[] = [];
      const fileSystem: SquirrelCleanupFileSystem = {
        access,
        readdir,
        rm: async (target, options) => {
          if (target === previousApp) throw new Error("version is still in use");
          await rm(target, options);
        }
      };

      await expect(cleanupSquirrelInstallation(
        path.join(currentApp, "AshAtlasAppearanceStudio.exe"),
        { fileSystem, onError: (error) => errors.push(error) }
      )).resolves.toMatchObject({
        currentVersion: "1.40.0",
        removedAppDirectories: [],
        removedFullPackages: [path.join(packages, "AshAtlasAppearanceStudio-1.39.0-full.nupkg")]
      });
      expect(errors).toHaveLength(1);
      await expect(access(previousApp)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
