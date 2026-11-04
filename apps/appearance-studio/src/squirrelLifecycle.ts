import { access, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export type SquirrelLifecycleAction =
  | { event: "--squirrel-install" | "--squirrel-updated"; shortcut: "create" }
  | { event: "--squirrel-uninstall"; shortcut: "remove" }
  | { event: "--squirrel-obsolete"; shortcut: null };

export interface SquirrelInstallationPaths {
  installRoot: string;
  currentAppDirectory: string;
  currentVersion: string;
  updateExecutable: string;
  packagesDirectory: string;
}

export interface SquirrelCleanupResult {
  currentVersion: string | null;
  removedAppDirectories: string[];
  removedFullPackages: string[];
  removedDeltaPackages: string[];
}

export interface SquirrelCleanupFileSystem {
  access: (path: string) => Promise<void>;
  readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  rm: (path: string, options: { force: true; recursive?: true }) => Promise<void>;
}

export interface SquirrelCleanupOptions {
  fileSystem?: SquirrelCleanupFileSystem;
  onError?: (error: unknown) => void;
}

const defaultSquirrelCleanupFileSystem: SquirrelCleanupFileSystem = {
  access,
  readdir,
  rm
};

const appDirectoryPattern = /^app-(\d+\.\d+\.\d+)$/u;
const fullPackagePattern = /^.+-(\d+\.\d+\.\d+)-full\.nupkg$/iu;
const deltaPackagePattern = /^.+-(\d+\.\d+\.\d+)-delta\.nupkg$/iu;

export function squirrelLifecycleAction(
  argv: readonly string[],
  platform: NodeJS.Platform
): SquirrelLifecycleAction | null {
  if (platform !== "win32") return null;
  for (const argument of argv) {
    if (argument === "--squirrel-install" || argument === "--squirrel-updated") {
      return { event: argument, shortcut: "create" };
    }
    if (argument === "--squirrel-uninstall") {
      return { event: argument, shortcut: "remove" };
    }
    if (argument === "--squirrel-obsolete") {
      return { event: argument, shortcut: null };
    }
  }
  return null;
}

export function squirrelInstallationPaths(
  executablePath: string
): SquirrelInstallationPaths | null {
  const currentAppDirectory = path.dirname(executablePath);
  const appDirectoryMatch = appDirectoryPattern.exec(path.basename(currentAppDirectory));
  if (!appDirectoryMatch) return null;
  const installRoot = path.dirname(currentAppDirectory);
  return {
    installRoot,
    currentAppDirectory,
    currentVersion: appDirectoryMatch[1]!,
    updateExecutable: path.join(installRoot, "Update.exe"),
    packagesDirectory: path.join(installRoot, "packages")
  };
}

export async function cleanupSquirrelInstallation(
  executablePath: string,
  options: SquirrelCleanupOptions = {}
): Promise<SquirrelCleanupResult> {
  const installation = squirrelInstallationPaths(executablePath);
  if (!installation) {
    return {
      currentVersion: null,
      removedAppDirectories: [],
      removedFullPackages: [],
      removedDeltaPackages: []
    };
  }

  const fileSystem = options.fileSystem ?? defaultSquirrelCleanupFileSystem;
  try {
    await fileSystem.access(installation.updateExecutable);
  } catch {
    return {
      currentVersion: null,
      removedAppDirectories: [],
      removedFullPackages: [],
      removedDeltaPackages: []
    };
  }

  const result: SquirrelCleanupResult = {
    currentVersion: installation.currentVersion,
    removedAppDirectories: [],
    removedFullPackages: [],
    removedDeltaPackages: []
  };
  await removeStaleAppDirectories(installation, fileSystem, result, options.onError);
  await removeStaleFullPackages(installation, fileSystem, result, options.onError);
  await removeStaleDeltaPackages(installation, fileSystem, result, options.onError);
  return result;
}

async function removeStaleAppDirectories(
  installation: SquirrelInstallationPaths,
  fileSystem: SquirrelCleanupFileSystem,
  result: SquirrelCleanupResult,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fileSystem.readdir(installation.installRoot, { withFileTypes: true });
  } catch (error) {
    reportCleanupError(error, onError);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !appDirectoryPattern.test(entry.name)) continue;
    if (entry.name.toLowerCase() === path.basename(installation.currentAppDirectory).toLowerCase()) {
      continue;
    }
    const directory = path.join(installation.installRoot, entry.name);
    try {
      await fileSystem.rm(directory, { force: true, recursive: true });
      result.removedAppDirectories.push(directory);
    } catch (error) {
      reportCleanupError(error, onError);
    }
  }
}

async function removeStaleFullPackages(
  installation: SquirrelInstallationPaths,
  fileSystem: SquirrelCleanupFileSystem,
  result: SquirrelCleanupResult,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fileSystem.readdir(installation.packagesDirectory, { withFileTypes: true });
  } catch (error) {
    reportCleanupError(error, onError);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const packageMatch = fullPackagePattern.exec(entry.name);
    if (!packageMatch || packageMatch[1] === installation.currentVersion) continue;
    const packagePath = path.join(installation.packagesDirectory, entry.name);
    try {
      await fileSystem.rm(packagePath, { force: true });
      result.removedFullPackages.push(packagePath);
    } catch (error) {
      reportCleanupError(error, onError);
    }
  }
}

async function removeStaleDeltaPackages(
  installation: SquirrelInstallationPaths,
  fileSystem: SquirrelCleanupFileSystem,
  result: SquirrelCleanupResult,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fileSystem.readdir(installation.packagesDirectory, { withFileTypes: true });
  } catch (error) {
    reportCleanupError(error, onError);
    return;
  }
  const currentFullPackageExists = entries.some((entry) => {
    if (!entry.isFile()) return false;
    const match = fullPackagePattern.exec(entry.name);
    return match?.[1] === installation.currentVersion;
  });
  if (!currentFullPackageExists) return;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!deltaPackagePattern.test(entry.name)) continue;
    const packagePath = path.join(installation.packagesDirectory, entry.name);
    try {
      await fileSystem.rm(packagePath, { force: true });
      result.removedDeltaPackages.push(packagePath);
    } catch (error) {
      reportCleanupError(error, onError);
    }
  }
}

function reportCleanupError(error: unknown, onError: ((error: unknown) => void) | undefined): void {
  if (!onError) return;
  try {
    onError(error);
  } catch {
    // Cleanup reporting is best effort and must never affect app startup.
  }
}
