import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type {
  StudioServerIdentity,
  StudioSession,
  StudioWorkspaceStatus
} from "./bridgeTypes.js";

export const OFFICIAL_APPEARANCE_STUDIO_PORT = 5285;
export const FEATURE_APPEARANCE_STUDIO_PORT_BASE = 25_285;
export const FEATURE_APPEARANCE_STUDIO_PORT_COUNT = 20_000;

export type ExpectedStudioIdentity = Pick<
  StudioServerIdentity,
  "worktreePath" | "branch" | "commitSha" | "port"
>;

export type StudioPortInspection =
  | { kind: "available" }
  | { kind: "reuse"; session: StudioSession }
  | {
      kind: "collision";
      pid: number | null;
      expected: ExpectedStudioIdentity;
      actual: StudioServerIdentity | null;
    };

const execFileAsync = promisify(execFile);
const STUDIO_SESSION_PROBE_TIMEOUT_MS = 5_000;
const STUDIO_SELF_VERIFICATION_ATTEMPTS = 3;
const STUDIO_SELF_VERIFICATION_RETRY_DELAY_MS = 250;

export function appearanceStudioPort(
  workspace: Pick<StudioWorkspaceStatus, "isLinkedWorktree" | "worktreePath" | "branch">,
  identity = `${workspace.worktreePath}|${workspace.branch ?? "detached"}`
): number {
  if (!workspace.isLinkedWorktree) return OFFICIAL_APPEARANCE_STUDIO_PORT;
  const hash = createHash("sha256").update(identity).digest();
  return FEATURE_APPEARANCE_STUDIO_PORT_BASE +
    hash.readUInt32BE(0) % FEATURE_APPEARANCE_STUDIO_PORT_COUNT;
}

export function expectedStudioIdentity(
  workspace: StudioWorkspaceStatus,
  environment: NodeJS.ProcessEnv = process.env
): ExpectedStudioIdentity {
  const worktreePath = environment.APPEARANCE_STUDIO_EXPECTED_WORKTREE ??
    workspace.worktreePath;
  const branch = environment.APPEARANCE_STUDIO_EXPECTED_BRANCH ??
    workspace.branch;
  const commitSha = environment.APPEARANCE_STUDIO_EXPECTED_COMMIT ??
    workspace.commitSha;
  const configuredPort =
    environment.APPEARANCE_STUDIO_EXPECTED_PORT ??
    environment.APPEARANCE_STUDIO_PORT;
  const port = configuredPort === undefined
    ? appearanceStudioPort(
        workspace,
        environment.APPEARANCE_STUDIO_IDENTITY ??
          `${worktreePath}|${branch ?? "detached"}`
      )
    : Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Appearance Studio port must be a valid TCP port");
  }
  const expected = { worktreePath, branch, commitSha, port };
  if (!studioIdentityMatches(expected, {
    ...expected,
    worktreePath: workspace.worktreePath,
    branch: workspace.branch,
    commitSha: workspace.commitSha
  })) {
    throw new Error(
      `Appearance Studio launcher identity is stale. Expected ${identityText(expected)}; ` +
      `actual checkout is ${identityText({
        ...expected,
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        commitSha: workspace.commitSha
      })}.`
    );
  }
  return expected;
}

export async function inspectStudioPort(
  expected: ExpectedStudioIdentity,
  options: {
    fetchSession?: (expected: ExpectedStudioIdentity) => Promise<StudioSession | null>;
    findListeningPid?: (port: number) => Promise<number | null>;
  } = {}
): Promise<StudioPortInspection> {
  const fetchSession = options.fetchSession ?? fetchStudioSession;
  const findListeningPid = options.findListeningPid ?? listeningPid;
  const session = await fetchSession(expected);
  if (session) {
    if (studioIdentityMatches(expected, session.server)) {
      return { kind: "reuse", session };
    }
    return {
      kind: "collision",
      pid: session.server.pid,
      expected,
      actual: session.server
    };
  }
  const pid = await findListeningPid(expected.port);
  return pid === null
    ? { kind: "available" }
    : { kind: "collision", pid, expected, actual: null };
}

export async function verifyStudioProcess(
  expected: ExpectedStudioIdentity,
  pid: number,
  options: {
    attempts?: number;
    retryDelayMs?: number;
    fetchSession?: (expected: ExpectedStudioIdentity) => Promise<StudioSession | null>;
    findListeningPid?: (port: number) => Promise<number | null>;
  } = {}
): Promise<StudioPortInspection> {
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? STUDIO_SELF_VERIFICATION_ATTEMPTS)
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? STUDIO_SELF_VERIFICATION_RETRY_DELAY_MS
  );
  let inspection: StudioPortInspection = { kind: "available" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    inspection = await inspectStudioPort(expected, options);
    if (inspection.kind === "reuse") {
      return inspection;
    }
    if (
      inspection.kind === "collision" &&
      (inspection.pid !== pid || inspection.actual !== null)
    ) {
      return inspection;
    }
    if (attempt < attempts - 1 && retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return inspection;
}

export function studioCollisionMessage(
  inspection: Extract<StudioPortInspection, { kind: "collision" }>
): string {
  const actualWorktree = inspection.actual?.worktreePath ??
    "unknown (the listener is not this Appearance Studio)";
  const actualBranch = inspection.actual?.branch ?? "unknown";
  const actualCommit = inspection.actual?.commitSha ?? "unknown";
  return [
    `Appearance Studio port ${inspection.expected.port} is owned by PID ${
      inspection.pid ?? "unknown"
    }.`,
    `Expected worktree: ${inspection.expected.worktreePath}`,
    `Actual worktree: ${actualWorktree}`,
    `Expected branch/SHA: ${inspection.expected.branch ?? "detached"}@${
      inspection.expected.commitSha
    }`,
    `Actual branch/SHA: ${actualBranch}@${actualCommit}`,
    "No process was stopped."
  ].join("\n");
}

export function studioIdentityMatches(
  expected: ExpectedStudioIdentity,
  actual: Pick<StudioServerIdentity, "worktreePath" | "branch" | "commitSha" | "port">
): boolean {
  return canonicalPath(expected.worktreePath) === canonicalPath(actual.worktreePath) &&
    expected.branch === actual.branch &&
    expected.commitSha.toLowerCase() === actual.commitSha.toLowerCase() &&
    expected.port === actual.port;
}

async function fetchStudioSession(
  expected: ExpectedStudioIdentity
): Promise<StudioSession | null> {
  const origin = `http://127.0.0.1:${expected.port}`;
  try {
    const response = await fetch(`${origin}/api/session`, {
      headers: { origin },
      signal: AbortSignal.timeout(STUDIO_SESSION_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const session = await response.json() as StudioSession;
    return session?.server ? session : null;
  } catch {
    return null;
  }
}

async function listeningPid(port: number): Promise<number | null> {
  if (process.platform !== "win32") return null;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -State Listen -LocalPort ${port} ` +
        "-ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"
      ],
      { encoding: "utf8", windowsHide: true, timeout: 2_000 }
    );
    const pid = Number(result.stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function identityText(identity: ExpectedStudioIdentity): string {
  return `${identity.worktreePath} (${identity.branch ?? "detached"}@${
    identity.commitSha
  }, port ${identity.port})`;
}

function canonicalPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}
