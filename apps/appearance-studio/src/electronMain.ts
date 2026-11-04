import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell
} from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  APPEARANCE_STUDIO_HOST,
  APPEARANCE_STUDIO_PORT,
  createAppearanceStudioBridge
} from "./bridge.js";
import {
  createContentBatch,
  finishContentBatch,
  inspectReleaseStatus,
  integrateContentBatch,
  publishIntegrationTest
} from "./desktopGit.js";
import type { AppearanceStudioDesktopController } from "./desktopContracts.js";
import type { StudioServerIdentity } from "./bridgeTypes.js";
import { inspectStudioPort, studioCollisionMessage } from "./launcherIdentity.js";
import {
  cleanupSquirrelInstallation,
  squirrelLifecycleAction
} from "./squirrelLifecycle.js";
import { inspectWorkspace } from "./workspaceSafety.js";

const DESKTOP_PORT = APPEARANCE_STUDIO_PORT;
const UI_ROOT = path.join(__dirname, "renderer");
let mainWindow: BrowserWindow | null = null;
let ownedBridge: Awaited<ReturnType<typeof createAppearanceStudioBridge>> | null = null;
let currentWorkspace = "";
let switching = false;

if (handleSquirrelEvent()) {
  // The installer event owns this short-lived process.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void app.whenReady().then(startDesktop).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    dialog.showErrorBox("Appearance Studio failed to start", message);
    app.quit();
  });
}

async function startDesktop(): Promise<void> {
  app.setAppUserModelId("com.ashatlas.appearance-studio");
  const workspace = await initialWorkspace();
  if (!workspace) {
    app.quit();
    return;
  }
  mainWindow = createWindow();
  installMenu();
  if (await switchWorkspace(workspace)) {
    cleanupSquirrelInstallationAfterLaunch();
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Ash Atlas Appearance Studio",
    width: 1540,
    height: 980,
    minWidth: 980,
    minHeight: 700,
    show: false,
    backgroundColor: "#111827",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url === "") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "Ash Atlas item display preview",
          width: 1200,
          height: 900,
          minWidth: 760,
          minHeight: 560,
          resizable: true,
          autoHideMenuBar: true,
          backgroundColor: "#070d16"
        }
      };
    }
    if (safeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const localOrigin = `http://${APPEARANCE_STUDIO_HOST}:${DESKTOP_PORT}`;
    if (url.startsWith(localOrigin)) return;
    event.preventDefault();
    if (safeExternalUrl(url)) void shell.openExternal(url);
  });
  window.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
  return window;
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "Open Ash Atlas Worktreeâ€¦",
          accelerator: "CmdOrCtrl+O",
          click: () => void chooseWorkspace().then((selected) => {
            if (selected) void switchWorkspace(selected);
          })
        },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" }
      ]
    }
  ]));
}

async function switchWorkspace(candidate: string): Promise<boolean> {
  if (switching) return false;
  switching = true;
  try {
    const worktreePath = await realpath(candidate);
    const workspace = await inspectWorkspace(worktreePath, 0);
    const expected = {
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      commitSha: workspace.commitSha,
      port: DESKTOP_PORT
    };
    if (ownedBridge) {
      await ownedBridge.close();
      ownedBridge = null;
    }
    const existing = await inspectStudioPort(expected);
    if (existing.kind === "collision") {
      throw new Error(studioCollisionMessage(existing));
    }
    if (existing.kind === "reuse") {
      throw new Error(
        "Another Appearance Studio owns the desktop port. Close it before switching worktrees."
      );
    }
    const serverIdentity: StudioServerIdentity = {
      ...expected,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    const desktop: AppearanceStudioDesktopController = {
      appVersion: app.getVersion(),
      createContentBatch: ({ slug }) => createContentBatch(worktreePath, slug),
      finishContentBatch: ({ summary }) => finishContentBatch(worktreePath, summary),
      releaseStatus: () => inspectReleaseStatus(worktreePath),
      integrateContentBatch: async () => {
        const status = await inspectReleaseStatus(worktreePath);
        const confirmation = await showConfirmation({
          title: "Integrate appearance batch?",
          message: "Merge this pushed feature branch into Integration Test?",
          detail:
            `${status.branch ?? "Detached branch"}@${status.commitSha.slice(0, 10)} will be ` +
            "accepted into a new numbered test generation. This does not deploy the public server.",
          confirmLabel: "Integrate into Test"
        });
        if (!confirmation) throw new Error("Integration canceled; nothing changed.");
        return integrateContentBatch(worktreePath);
      },
      publishIntegrationTest: async (input) => {
        const confirmation = await showConfirmation({
          title: "Deploy the public test server?",
          message: `Publish all of ${input.approvedGeneration} to master and the public server?`,
          detail:
            `Approved SHA: ${input.approvedSha}\n\nThis deploys every change in ` +
            `${input.approvedGeneration}, not only this appearance batch.`,
          confirmLabel: "Publish & Deploy"
        });
        if (!confirmation) throw new Error("Deployment canceled; nothing changed.");
        return publishIntegrationTest(worktreePath, input);
      },
      openExternal: async (url) => {
        if (!safeExternalUrl(url)) throw new Error("External URL is not allowed");
        await shell.openExternal(url);
      },
      requestWorkspaceSwitch: (nextWorktreePath) => {
        setTimeout(() => void switchWorkspace(nextWorktreePath), 150);
      }
    };
    const bridge = await createAppearanceStudioBridge({
      repositoryRoot: worktreePath,
      port: DESKTOP_PORT,
      serverIdentity,
      uiRoot: UI_ROOT,
      desktop
    });
    await bridge.listen({ host: APPEARANCE_STUDIO_HOST, port: DESKTOP_PORT });
    ownedBridge = bridge;
    currentWorkspace = worktreePath;
    await saveWorkspace(worktreePath);
    await mainWindow?.loadURL(`http://${APPEARANCE_STUDIO_HOST}:${DESKTOP_PORT}`);
    mainWindow?.setTitle(
      `Ash Atlas Appearance Studio â€” ${path.basename(worktreePath)} â€” ${
        workspace.branch ?? "detached"
      }`
    );
    return true;
  } catch (error) {
    await showMessage({
      type: "error",
      title: "Appearance Studio could not open the worktree",
      message: error instanceof Error ? error.message : "Unknown workspace error"
    });
    if (!ownedBridge && currentWorkspace) {
      const prior = currentWorkspace;
      currentWorkspace = "";
      switching = false;
      return switchWorkspace(prior);
    }
    return false;
  } finally {
    switching = false;
  }
}

async function showConfirmation(input: {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: [input.confirmLabel, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: input.title,
    message: input.message,
    detail: input.detail
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function initialWorkspace(): Promise<string | null> {
  const argument = process.argv.find((value) => value.startsWith("--workspace="))
    ?.slice("--workspace=".length);
  const saved = await loadWorkspace();
  const conventional = path.join(app.getPath("documents"), "game");
  for (const candidate of [argument, saved, conventional]) {
    if (candidate && await isGitWorkspace(candidate)) return candidate;
  }
  return chooseWorkspace();
}

async function chooseWorkspace(): Promise<string | null> {
  const options = {
    title: "Select an Ash Atlas checkout or task worktree",
    defaultPath: currentWorkspace || app.getPath("documents"),
    properties: ["openDirectory"] as Array<"openDirectory">
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  if (!await isGitWorkspace(result.filePaths[0])) {
    await showMessage({
      type: "error",
      title: "Not an Ash Atlas worktree",
      message: "Select the game checkout or one of its linked task worktrees."
    });
    return chooseWorkspace();
  }
  return result.filePaths[0];
}

async function showMessage(
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function safeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
  } catch {
    return false;
  }
}

async function isGitWorkspace(candidate: string): Promise<boolean> {
  try {
    await access(path.join(candidate, "package.json"));
    await inspectWorkspace(candidate, 0);
    return true;
  } catch {
    return false;
  }
}

async function loadWorkspace(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), "utf8")) as {
      worktreePath?: unknown;
    };
    return typeof parsed.worktreePath === "string" ? parsed.worktreePath : null;
  } catch {
    return null;
  }
}

async function saveWorkspace(worktreePath: string): Promise<void> {
  const destination = settingsPath();
  const temporary = `${destination}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ worktreePath }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporary, destination);
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

app.on("before-quit", () => {
  if (ownedBridge) void ownedBridge.close();
});

function handleSquirrelEvent(): boolean {
  const action = squirrelLifecycleAction(process.argv, process.platform);
  if (!action) return false;
  const applicationFolder = path.dirname(process.execPath);
  const updateExe = path.resolve(applicationFolder, "..", "Update.exe");
  const executableName = path.basename(process.execPath);
  const finish = (): void => app.exit(0);
  if (action.shortcut) {
    const child = spawn(
      updateExe,
      [action.shortcut === "create" ? "--createShortcut" : "--removeShortcut", executableName],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    );
    child.on("error", () => {});
    child.unref();
  }
  if (action.event === "--squirrel-install" || action.event === "--squirrel-updated") {
    void cleanupSquirrelInstallationAfterLaunch(finish);
  } else {
    finish();
  }
  return true;
}

function cleanupSquirrelInstallationAfterLaunch(onComplete?: () => void): void {
  void cleanupSquirrelInstallation(process.execPath, {
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Appearance Studio install cleanup skipped: ${message}`);
    }
  }).then(() => onComplete?.(), () => onComplete?.());
}
