import { packager } from "@electron/packager";
import { build } from "esbuild";
import { createWindowsInstaller } from "electron-winstaller";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDesktopReleaseSource,
  inspectDesktopBuildSource
} from "../src/desktopBuildSource.js";
import {
  APPEARANCE_STUDIO_CONTRACT_VERSION,
  APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION
} from "../src/desktopContracts.js";
import {
  assertSquirrelDeltaEntryNames,
  retainSquirrelReleaseManifest,
  squirrelReleasePlan,
  squirrelReleasePackageNames,
  squirrelReleasePackageNamesToRemoveAfterPackaging,
  squirrelReleasePackageNamesToRemoveBeforePackaging,
  squirrelReleasePlanMessage,
  squirrelZipEntryNames
} from "../src/squirrelPackaging.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const stageRoot = path.join(packageRoot, ".desktop-stage");
const outRoot = path.join(packageRoot, "out");
const portableRoot = path.join(outRoot, "portable");
const installerDirectory = path.join(outRoot, "installer");
const productName = "Ash Atlas Appearance Studio";
const squirrelName = "AshAtlasAppearanceStudio";
const executableName = squirrelName;
const icon = path.join(repositoryRoot, "apps/client/public/favicon.ico");
const packageManifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8")
) as { version?: string; devDependencies?: Record<string, string> };
const version = packageManifest.version ?? "";
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error(`Appearance Studio version is invalid: ${version || "missing"}`);
}
const configuredElectron = packageManifest.devDependencies?.electron ?? "";
const electronVersion = /\d+\.\d+\.\d+/u.exec(configuredElectron)?.[0];
if (!electronVersion) {
  throw new Error(`Electron version is invalid: ${configuredElectron || "missing"}`);
}
const stageOnly = process.argv.includes("--stage-only");
const buildSource = await inspectDesktopBuildSource(repositoryRoot);
if (!stageOnly) assertDesktopReleaseSource(buildSource);

await rm(stageRoot, { recursive: true, force: true });
await mkdir(path.join(stageRoot, "renderer"), { recursive: true });
await cp(path.join(packageRoot, "dist"), path.join(stageRoot, "renderer"), {
  recursive: true
});
await build({
  entryPoints: [path.join(packageRoot, "src/electronMain.ts")],
  outfile: path.join(stageRoot, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "vite"],
  logOverride: {
    "empty-import-meta": "silent"
  },
  define: {
    "process.env.NODE_ENV": '"production"'
  }
});
await writeFile(path.join(stageRoot, "package.json"), `${JSON.stringify({
  name: "ash-atlas-appearance-studio",
  productName,
  version,
  description: "Ash Atlas appearance and item authoring desktop application",
  author: "Ash Atlas",
  main: "main.cjs",
  ashAtlasSourceSha: buildSource.commitSha,
  ashAtlasSourceDirty: !buildSource.clean,
  ashAtlasTestGeneration: buildSource.branch === "integration/test" && buildSource.clean
    ? buildSource.generationTags[0] ?? null
    : null,
  appearanceStudioContractVersion: APPEARANCE_STUDIO_CONTRACT_VERSION,
  minimumDesktopVersion: APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION
}, null, 2)}\n`);

if (stageOnly) {
  console.log(`Desktop stage ready: ${stageRoot}`);
  process.exit(0);
}

const priorReleaseFiles = await releaseFileNames(installerDirectory);
const releasePlan = squirrelReleasePlan(priorReleaseFiles, version);
console.log(squirrelReleasePlanMessage(releasePlan));
await removeReleaseFiles(
  installerDirectory,
  squirrelReleasePackageNamesToRemoveBeforePackaging(priorReleaseFiles, releasePlan.packageName)
);
await trimReleaseManifest(installerDirectory, releasePlan.packageName ? [releasePlan.packageName] : []);
await rm(portableRoot, { recursive: true, force: true });
await mkdir(portableRoot, { recursive: true });
const packaged = await packager({
  dir: stageRoot,
  out: portableRoot,
  name: squirrelName,
  executableName,
  appVersion: version,
  buildVersion: version,
  platform: "win32",
  arch: "x64",
  electronVersion,
  overwrite: true,
  asar: true,
  prune: false,
  icon,
  win32metadata: {
    CompanyName: "Ash Atlas",
    FileDescription: productName,
    ProductName: productName,
    InternalName: "AshAtlasAppearanceStudio",
    OriginalFilename: `${executableName}.exe`,
    "requested-execution-level": "asInvoker"
  }
});
const appDirectory = packaged[0];
if (!appDirectory) throw new Error("Electron Packager did not return an application directory");
await mkdir(installerDirectory, { recursive: true });
await rm(path.join(installerDirectory, "Setup.exe"), { force: true });
await rm(path.join(installerDirectory, `${productName} Setup.exe`), { force: true });
await createWindowsInstaller({
  appDirectory,
  outputDirectory: installerDirectory,
  authors: "Ash Atlas",
  owners: "Ash Atlas",
  description: "Ash Atlas appearance and item authoring desktop application",
  title: productName,
  name: squirrelName,
  version,
  exe: `${executableName}.exe`,
  setupExe: `${productName} Setup.exe`,
  setupIcon: icon,
  noMsi: true,
  noDelta: releasePlan.noDelta,
  usePackageJson: false
});
const generatedReleaseFiles = await releaseFileNames(installerDirectory);
await removeReleaseFiles(
  installerDirectory,
  squirrelReleasePackageNamesToRemoveAfterPackaging(
    generatedReleaseFiles,
    version,
    releasePlan.packageName
  )
);
const retainedReleaseFiles = await releaseFileNames(installerDirectory);
await trimReleaseManifest(
  installerDirectory,
  squirrelReleasePackageNames(retainedReleaseFiles)
);
const generatedFileSet = new Set(retainedReleaseFiles.map((fileName) => fileName.toLowerCase()));
const currentFullPackage = `ashatlasappearancestudio-${version}-full.nupkg`;
if (!generatedFileSet.has(currentFullPackage)) {
  throw new Error(`Squirrel did not emit the required full package ${currentFullPackage}.`);
}
if (!generatedFileSet.has("releases")) {
  throw new Error("Squirrel did not emit the required RELEASES manifest.");
}
const currentSetup = `${productName} Setup.exe`.toLowerCase();
if (!generatedFileSet.has(currentSetup)) {
  throw new Error(`Squirrel did not emit the required setup executable ${currentSetup}.`);
}
const currentDeltaPackage = `ashatlasappearancestudio-${version}-delta.nupkg`;
if (releasePlan.noDelta) {
  console.log("Squirrel release output is full-only; seed the installer directory with a prior " +
    "full package before the next patch build to enable deltas.");
} else if (generatedFileSet.has(currentDeltaPackage)) {
  const deltaPath = path.join(installerDirectory, currentDeltaPackage);
  assertSquirrelDeltaEntryNames(squirrelZipEntryNames(await readFile(deltaPath)));
  console.log(`Squirrel delta package: ${path.join(installerDirectory, currentDeltaPackage)}`);
} else {
  console.warn(`Squirrel did not emit the expected delta package ${currentDeltaPackage}; ` +
    "the full package remains available for recovery.");
}
console.log(`Portable app: ${path.join(appDirectory, `${executableName}.exe`)}`);
console.log(`Installer: ${path.join(installerDirectory, `${productName} Setup.exe`)}`);

async function releaseFileNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

async function removeReleaseFiles(directory: string, fileNames: readonly string[]): Promise<void> {
  for (const fileName of fileNames) {
    await rm(path.join(directory, fileName), { force: true });
  }
}

async function trimReleaseManifest(
  directory: string,
  retainedPackageNames: readonly string[]
): Promise<void> {
  const manifestPath = path.join(directory, "RELEASES");
  try {
    const contents = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, retainSquirrelReleaseManifest(contents, retainedPackageNames));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
