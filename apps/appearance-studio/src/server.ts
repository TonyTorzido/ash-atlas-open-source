import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  APPEARANCE_STUDIO_HOST,
  createAppearanceStudioBridge
} from "./bridge.js";
import {
  expectedStudioIdentity,
  inspectStudioPort,
  studioCollisionMessage,
  verifyStudioProcess
} from "./launcherIdentity.js";
import { inspectWorkspace } from "./workspaceSafety.js";

const repositoryRoot = await realpath(
  fileURLToPath(new URL("../../..", import.meta.url))
);
const launchWorkspace = await inspectWorkspace(repositoryRoot, 0);
const expected = expectedStudioIdentity(launchWorkspace);
const origin = `http://${APPEARANCE_STUDIO_HOST}:${expected.port}`;
const existing = await inspectStudioPort(expected);

if (existing.kind === "reuse") {
  console.log(
    `Appearance Studio already running for ${expected.worktreePath} ` +
    `(${expected.branch ?? "detached"}@${expected.commitSha}) on ${origin}; reusing PID ${
      existing.session.server.pid
    }.`
  );
  openBrowser(origin);
  process.exit(0);
}
if (existing.kind === "collision") {
  throw new Error(studioCollisionMessage(existing));
}

const serverIdentity = {
  ...expected,
  pid: process.pid,
  startedAt: new Date().toISOString()
};
const app = await createAppearanceStudioBridge({
  repositoryRoot,
  port: expected.port,
  serverIdentity
});
try {
  await app.listen({
    host: APPEARANCE_STUDIO_HOST,
    port: expected.port
  });
} catch (error) {
  const raced = await inspectStudioPort(expected);
  if (raced.kind === "reuse") {
    openBrowser(origin);
    process.exit(0);
  }
  if (raced.kind === "collision") {
    throw new Error(studioCollisionMessage(raced), { cause: error });
  }
  throw error;
}

const verified = await verifyStudioProcess(expected, process.pid);
if (verified.kind !== "reuse" || verified.session.server.pid !== process.pid) {
  await app.close();
  if (verified.kind === "collision") {
    throw new Error(studioCollisionMessage(verified));
  }
  throw new Error(
    `Appearance Studio started on ${origin}, but /api/session did not verify ` +
    `${expected.worktreePath} (${expected.branch ?? "detached"}@${expected.commitSha}).`
  );
}

app.log.info(
  {
    origin,
    pid: process.pid,
    worktreePath: expected.worktreePath,
    branch: expected.branch,
    commitSha: expected.commitSha
  },
  "Ash Atlas Appearance Studio is ready"
);
openBrowser(origin);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await app.close();
};
process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});

function openBrowser(address: string): void {
  if (process.env.STUDIO_OPEN_BROWSER !== "1" || process.platform !== "win32") return;
  const child = spawn(
    "cmd.exe",
    ["/d", "/s", "/c", "start", "", address],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
}
