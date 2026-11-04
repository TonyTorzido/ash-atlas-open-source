import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { StudioWorkspaceStatus } from "./bridgeTypes.js";
import {
  APPEARANCE_STUDIO_CONTRACT_VERSION,
  MIN_APPEARANCE_STUDIO_CONTRACT_VERSION
} from "./desktopContracts.js";

export const APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH =
  "config/appearance-studio.compatibility.json";

const execFileAsync = promisify(execFile);

export async function inspectWorkspace(
  repositoryPath: string,
  catalogRevision: number
): Promise<StudioWorkspaceStatus> {
  const worktreePath = await realpath(repositoryPath);
  const [branchResult, commitResult, rootResult, gitDirResult, commonDirResult] =
    await Promise.all([
    git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], true),
    git(worktreePath, ["rev-parse", "HEAD"]),
    git(worktreePath, ["rev-parse", "--show-toplevel"]),
    git(worktreePath, ["rev-parse", "--git-dir"]),
    git(worktreePath, ["rev-parse", "--git-common-dir"])
  ]);
  const branch = branchResult || null;
  const commitSha = commitResult.trim();
  const repositoryRoot = await realpath(rootResult.trim());
  const gitDir = path.resolve(worktreePath, gitDirResult.trim());
  const commonDir = path.resolve(worktreePath, commonDirResult.trim());
  const compatibility = await inspectCompatibility(repositoryRoot);
  const reason = writeBlockReason(branch, gitDir !== commonDir) ??
    (compatibility.compatible
      ? null
      : `Appearance Studio contract ${compatibility.contractVersion ?? "missing"} is not ` +
        `supported by this app (${compatibility.supportedContractVersion}).`);
  return {
    repositoryPath: repositoryRoot,
    worktreePath,
    branch,
    commitSha,
    writesAllowed: reason === null,
    writeBlockReason: reason,
    catalogRevision,
    isLinkedWorktree: gitDir !== commonDir,
    compatibility
  };
}

async function inspectCompatibility(
  repositoryRoot: string
): Promise<StudioWorkspaceStatus["compatibility"]> {
  let contractVersion: number | null = null;
  let minimumDesktopVersion: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(
      path.join(repositoryRoot, APPEARANCE_STUDIO_COMPATIBILITY_RELATIVE_PATH),
      "utf8"
    )) as { contractVersion?: unknown; minimumDesktopVersion?: unknown };
    if (Number.isInteger(parsed.contractVersion)) {
      contractVersion = parsed.contractVersion as number;
    }
    if (typeof parsed.minimumDesktopVersion === "string") {
      minimumDesktopVersion = parsed.minimumDesktopVersion;
    }
  } catch {
    // Missing or malformed compatibility metadata is safely read-only.
  }
  return {
    contractVersion,
    supportedContractVersion: APPEARANCE_STUDIO_CONTRACT_VERSION,
    minimumDesktopVersion,
    compatible: contractVersion !== null &&
      contractVersion >= MIN_APPEARANCE_STUDIO_CONTRACT_VERSION &&
      contractVersion <= APPEARANCE_STUDIO_CONTRACT_VERSION
  };
}

export function writeBlockReason(
  branch: string | null,
  isLinkedWorktree: boolean
): string | null {
  if (!branch) return "Detached Git worktrees cannot author appearance content.";
  if (
    branch === "master" ||
    branch === "integration/test" ||
    /^test\/t\d+$/u.test(branch)
  ) {
    return `Protected branch ${branch} cannot author appearance content.`;
  }
  if (!/^(feature|fix|chore|audit|integration)\/[a-z0-9][a-z0-9/_-]*$/u.test(branch)) {
    return "Appearance content must be authored on an approved task branch.";
  }
  if (!isLinkedWorktree) {
    return "The permanent protected checkout cannot author appearance content.";
  }
  return null;
}

async function git(
  cwd: string,
  args: string[],
  allowFailure = false
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true
    });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}
