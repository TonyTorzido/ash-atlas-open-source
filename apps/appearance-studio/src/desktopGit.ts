import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  CreateContentBatchResponse,
  DesktopReleaseStatus,
  IntegrateContentBatchResponse,
  PublishIntegrationTestRequest,
  PublishIntegrationTestResponse,
  FinishContentBatchResponse
} from "./desktopContracts.js";
import { inspectWorkspace } from "./workspaceSafety.js";

const execFileAsync = promisify(execFile);
const CONTENT_FILES = [
  "packages/shared/src/data/player-appearance-catalog.json",
  "packages/shared/src/data/boss-appearance-catalog.json",
  "packages/shared/src/data/item-variant-catalog.json",
  "packages/shared/src/data/runtime-png-asset-metadata.json",
  "packages/shared/src/data/runtime-png-presentation.json",
  "packages/shared/src/data/progression-icon-presentation.json",
  "packages/shared/src/data/territory-structure-catalog.json"
] as const;
const CONTENT_DIRECTORIES = [
  // Interior Studio publishes into the unified interior data (one file per space, _library.json, index.ts).
  "packages/shared/src/data/interiors",
  "packages/player-renderer/src/assets/player-appearance",
  "packages/player-renderer/src/assets/boss-appearance"
] as const;
const PNG_CONTENT_DIRECTORIES = [
  "apps/client/src/assets",
  "apps/client/public"
] as const;
const MERGED_RECEIPT_PATH = "__MERGED_TO_TEST__.md";
const STUDIO_PLAYER_PATCH_NOTE = "Improved Visuals";

export async function createContentBatch(
  repositoryPath: string,
  requestedSlug: string
): Promise<CreateContentBatchResponse> {
  const slug = contentBatchSlug(requestedSlug);
  const worktreeList = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
  const mainWorktree = await realpath(mainWorktreePath(worktreeList));
  await refreshGitIndex(mainWorktree);
  const permanentStatus = await git(mainWorktree, [
    "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  if (permanentStatus.trim()) {
    throw new Error("The permanent Ash Atlas checkout is dirty; no content worktree was created.");
  }

  await git(mainWorktree, ["fetch", "origin", "--prune", "--tags"]);
  const remote = await git(mainWorktree, [
    "ls-remote",
    "--refs",
    "origin",
    "refs/heads/integration/test",
    "refs/tags/test/t*"
  ]);
  const generation = remoteGeneration(remote);
  const branch = `feature/${slug}--from-${generation.tag}`;
  const worktreesRoot = path.join(path.dirname(mainWorktree), "worktrees");
  const worktreePath = path.join(worktreesRoot, `${slug}__${generation.tag}`);

  if (await exists(worktreePath)) {
    throw new Error(`Content worktree already exists: ${worktreePath}`);
  }
  if (await gitExists(mainWorktree, ["show-ref", "--verify", `refs/heads/${branch}`])) {
    throw new Error(`Local branch already exists: ${branch}`);
  }
  if ((await git(mainWorktree, ["ls-remote", "--heads", "origin", branch])).trim()) {
    throw new Error(`Remote branch already exists: ${branch}`);
  }

  await mkdir(worktreesRoot, { recursive: true });
  await git(mainWorktree, [
    "worktree", "add", "-b", branch, worktreePath, generation.sha
  ]);
  await git(worktreePath, ["push", "--set-upstream", "origin", branch]);

  const workspace = await inspectWorkspace(worktreePath, 0);
  if (!workspace.compatibility.compatible) {
    throw new Error(
      `Created ${branch}, but its Appearance Studio contract is incompatible. ` +
      "The worktree was preserved for inspection."
    );
  }
  return {
    worktreePath,
    branch,
    baseGeneration: generation.tag,
    baseSha: generation.sha
  };
}

export async function finishContentBatch(
  worktreePath: string,
  requestedSummary: string
): Promise<FinishContentBatchResponse> {
  const summary = contentBatchSummary(requestedSummary);
  const workspace = await inspectWorkspace(worktreePath, 0);
  if (!workspace.writesAllowed || !workspace.branch) {
    throw new Error(workspace.writeBlockReason ?? "This worktree cannot finish a content batch.");
  }
  const status = await git(worktreePath, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all"
  ]);
  const changedPaths = statusPaths(status);
  if (changedPaths.length === 0) {
    const recovered = await recoverCommittedContentBatch(worktreePath, workspace.branch);
    if (recovered) return recovered;
    throw new Error(
      "There are no saved appearance changes to finish. If a previous commit succeeded, " +
      "retry with the same feature worktree and commit subject."
    );
  }
  const unrelated = changedPaths.filter((candidate) =>
    candidate !== MERGED_RECEIPT_PATH && !isAppearanceContentPath(candidate)
  );
  if (unrelated.length > 0) {
    throw new Error(
      "Finish Batch found unrelated changes and refused to stage them: " + unrelated.join(", ")
    );
  }

  await git(worktreePath, ["diff", "--check"]);
  const allowedChangedPaths = changedPaths.filter((candidate) =>
    candidate !== MERGED_RECEIPT_PATH && isAppearanceContentPath(candidate)
  );
  if (allowedChangedPaths.length === 0) {
    throw new Error("There are no appearance changes to commit.");
  }
  await git(worktreePath, ["add", "-A", "--", ...allowedChangedPaths]);
  await git(worktreePath, ["diff", "--cached", "--check"]);
  const staged = (await git(worktreePath, [
    "diff", "--cached", "--name-only"
  ])).split(/\r?\n/u).filter(Boolean);
  if (staged.length === 0) {
    throw new Error("There are no appearance changes to commit.");
  }

  await git(worktreePath, ["commit", "-m", `feat(appearance): ${summary}`]);
  const commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  await pushAndVerifyFeatureCommit(worktreePath, workspace.branch, commitSha);
  return {
    branch: workspace.branch,
    commitSha,
    changedFiles: staged,
    pushed: true
  };
}

async function recoverCommittedContentBatch(
  worktreePath: string,
  branch: string
): Promise<FinishContentBatchResponse | null> {
  const commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  const subject = (await git(worktreePath, ["log", "-1", "--format=%s"])).trim();
  if (!subject.startsWith("feat(appearance): ")) return null;
  const changedFiles = (await git(worktreePath, [
    "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"
  ])).split(/\r?\n/u).map(normalizedGitPath).filter(Boolean);
  if (
    changedFiles.length === 0 ||
    changedFiles.some((candidate) => !isAppearanceContentPath(candidate))
  ) return null;
  await pushAndVerifyFeatureCommit(worktreePath, branch, commitSha);
  return {
    branch,
    commitSha,
    changedFiles,
    pushed: true
  };
}

async function pushAndVerifyFeatureCommit(
  worktreePath: string,
  branch: string,
  commitSha: string
): Promise<void> {
  try {
    await git(worktreePath, ["push", "origin", branch]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local Studio commit ${commitSha.slice(0, 10)} is ready on ${branch}, but push failed. ` +
      "Retry Commit & Push after resolving remote access. " + detail
    );
  }
  let remote: string;
  try {
    remote = await git(worktreePath, [
      "ls-remote", "--heads", "origin", `refs/heads/${branch}`
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local Studio commit ${commitSha.slice(0, 10)} was pushed, but remote verification failed. ` +
      `Retry Commit & Push to verify ${branch} after resolving remote access. ${detail}`
    );
  }
  const remoteSha = remoteRefSha(remote, `refs/heads/${branch}`, false);
  if (remoteSha !== commitSha.toLowerCase()) {
    throw new Error(
      `Local Studio commit ${commitSha.slice(0, 10)} was created, but origin/${branch} ` +
      `points to ${remoteSha ? remoteSha.slice(0, 10) : "no commit"}. ` +
      "Retry Commit & Push after resolving the remote branch state."
    );
  }
}

export async function inspectReleaseStatus(
  worktreePath: string
): Promise<DesktopReleaseStatus> {
  const worktreeList = await git(worktreePath, ["worktree", "list", "--porcelain"]);
  const mainWorktree = await realpath(mainWorktreePath(worktreeList));
  await git(mainWorktree, ["fetch", "origin", "--prune", "--tags"]);
  const [branch, commitSha, status, remote] = await Promise.all([
    git(worktreePath, ["branch", "--show-current"]),
    git(worktreePath, ["rev-parse", "HEAD"]),
    git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(mainWorktree, [
      "ls-remote",
      "--refs",
      "origin",
      "refs/heads/integration/test",
      "refs/heads/master",
      "refs/heads/*",
      "refs/tags/test/t*"
    ])
  ]);
  const normalizedBranch = branch.trim() || null;
  const normalizedCommit = commitSha.trim();
  const worktreeClean = status.split(/\r?\n/u).every((line) =>
    !line || line.slice(3).replaceAll("\\", "/") === MERGED_RECEIPT_PATH
  );
  const generation = remoteGeneration(remote);
  const masterSha = remoteRefSha(remote, "refs/heads/master");
  const remoteFeatureSha = normalizedBranch
    ? remoteRefSha(remote, `refs/heads/${normalizedBranch}`, false)
    : "";
  const commitIntegrated = await gitExists(mainWorktree, [
    "merge-base", "--is-ancestor", normalizedCommit, generation.sha
  ]);
  const commitPublished = Boolean(masterSha) && await gitExists(mainWorktree, [
    "merge-base", "--is-ancestor", normalizedCommit, masterSha
  ]);
  return {
    branch: normalizedBranch,
    commitSha: normalizedCommit,
    worktreeClean,
    featurePushed: worktreeClean && remoteFeatureSha === normalizedCommit,
    featureIntegrated: worktreeClean && commitIntegrated,
    featurePublished: worktreeClean && commitPublished,
    integrationGeneration: generation.tag,
    integrationSha: generation.sha,
    masterSha,
    integrationPublished: masterSha === generation.sha
  };
}

export async function integrateContentBatch(
  worktreePath: string
): Promise<IntegrateContentBatchResponse> {
  const before = await inspectReleaseStatus(worktreePath);
  if (!before.branch || !before.worktreeClean || !before.featurePushed) {
    throw new Error(
      "Commit and push a clean feature branch before integrating it into Integration Test."
    );
  }
  if (!before.featureIntegrated) {
    await runRelease(worktreePath, contentBatchIntegrationArgs(worktreePath));
  }
  const after = await inspectReleaseStatus(worktreePath);
  if (!after.featureIntegrated) {
    throw new Error("Integration finished without including this feature commit.");
  }
  return {
    generation: after.integrationGeneration,
    integrationSha: after.integrationSha,
    featureIntegrated: true
  };
}

export function contentBatchIntegrationArgs(worktreePath: string): string[] {
  return [
    "Integrate",
    "-FeatureWorktree", worktreePath,
    "-DisplayName", "Appearance Content",
    "-PlayerPatchNote", STUDIO_PLAYER_PATCH_NOTE,
    "-ConfirmIntegration",
    "-ConfirmGenerationCheckpoint"
  ];
}

export async function publishIntegrationTest(
  worktreePath: string,
  input: PublishIntegrationTestRequest
): Promise<PublishIntegrationTestResponse> {
  const before = await inspectReleaseStatus(worktreePath);
  if (!before.featureIntegrated) {
    throw new Error("Integrate this feature into Integration Test before deploying it.");
  }
  assertApprovedIntegrationTest(input, before);
  if (!before.integrationPublished) {
    await runRelease(worktreePath, [
      "Publish",
      "-ApprovedIntegrationTest",
      "-ConfirmPublish",
      "-ConfirmDeploy"
    ]);
  }
  const after = await inspectReleaseStatus(worktreePath);
  if (after.masterSha !== input.approvedSha.toLowerCase()) {
    throw new Error("Deployment finished without publishing the approved Integration Test SHA.");
  }
  return {
    generation: input.approvedGeneration,
    deployedSha: after.masterSha,
    verified: true
  };
}

export function assertApprovedIntegrationTest(
  input: PublishIntegrationTestRequest,
  status: Pick<DesktopReleaseStatus, "integrationGeneration" | "integrationSha">
): void {
  if (
    input.approvedGeneration !== status.integrationGeneration ||
    input.approvedSha.toLowerCase() !== status.integrationSha
  ) {
    throw new Error(
      "Integration Test changed after confirmation. Review the new generation before deploying."
    );
  }
}

export function contentBatchSlug(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!slug || slug.length > 26) {
    throw new Error("Batch name must produce a 1-26 character lowercase slug.");
  }
  return slug;
}

export function contentBatchSummary(value: string): string {
  if (/[\r\n]/u.test(value) || value.includes("\0")) {
    throw new Error("Commit summary must be 1-48 plain-text characters.");
  }
  const summary = value.trim().replace(/\s+/gu, " ");
  if (!summary || summary.length > 48) {
    throw new Error("Commit summary must be 1-48 plain-text characters.");
  }
  return summary;
}

export function remoteGeneration(value: string): { tag: string; sha: string } {
  let integrationSha = "";
  const tags: Array<{ tag: string; sha: string }> = [];
  for (const line of value.split(/\r?\n/u)) {
    if (!line) continue;
    const [sha, ref] = line.split(/\s+/u);
    if (!sha || !ref) continue;
    if (ref === "refs/heads/integration/test") integrationSha = sha;
    const match = /^refs\/tags\/test\/(t\d+)$/u.exec(ref);
    if (match?.[1]) tags.push({ tag: match[1], sha });
  }
  if (!integrationSha) {
    throw new Error(
      "origin/integration/test was not found; fetch origin and verify the dedicated Integration Test checkout."
    );
  }
  const exact = tags.filter(({ sha }) => sha === integrationSha);
  if (exact.length !== 1) {
    throw new Error(
      `origin/integration/test must have exactly one immutable generation tag (found ${exact.length}).`
    );
  }
  return { tag: exact[0]!.tag, sha: integrationSha };
}

function mainWorktreePath(value: string): string {
  const first = value.split(/\r?\n/u).find((line) => line.startsWith("worktree "));
  if (!first) throw new Error("Git did not report a permanent worktree.");
  return first.slice("worktree ".length);
}

export function integrationWorktreePath(value: string): string {
  const matches: string[] = [];
  let worktree: string | null = null;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      worktree = line.slice("worktree ".length);
    } else if (line === "branch refs/heads/integration/test" && worktree) {
      matches.push(worktree);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one dedicated integration/test worktree; found ${matches.length}.`
    );
  }
  return matches[0]!;
}

function remoteRefSha(value: string, expectedRef: string, required = true): string {
  for (const line of value.split(/\r?\n/u)) {
    const [sha, ref] = line.split(/\s+/u);
    if (ref === expectedRef && sha) return sha.toLowerCase();
  }
  if (required) throw new Error(`Remote ref was not found: ${expectedRef}`);
  return "";
}

async function runRelease(worktreePath: string, args: string[]): Promise<void> {
  const worktreeList = await git(worktreePath, ["worktree", "list", "--porcelain"]);
  const integrationWorktree = await realpath(integrationWorktreePath(worktreeList));
  const script = path.join(
    integrationWorktree,
    "tools",
    "release",
    "accept-and-publish-test-server.ps1"
  );
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      ...args
    ], {
      cwd: integrationWorktree,
      encoding: "utf8",
      windowsHide: true,
      timeout: 35 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [detail.stdout, detail.stderr, detail.message]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n") || "Ash Atlas release workflow failed"
    );
  }
}

function statusPaths(value: string): string[] {
  const records = value.split("\0");
  const result: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    result.push(normalizedGitPath(record.slice(3)));
    if (status.includes("R") || status.includes("C")) {
      const prior = records[index + 1];
      if (prior) result.push(normalizedGitPath(prior));
      index += 1;
    }
  }
  return [...new Set(result)];
}

function isAppearanceContentPath(candidate: string): boolean {
  if (CONTENT_FILES.some((contentPath) => candidate === contentPath)) return true;
  if (CONTENT_DIRECTORIES.some((contentPath) =>
    candidate === contentPath || candidate.startsWith(`${contentPath}/`)
  )) return true;
  return PNG_CONTENT_DIRECTORIES.some((contentPath) =>
    candidate.startsWith(`${contentPath}/`) && /\.png$/iu.test(candidate)
  );
}

function normalizedGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    return result.stdout;
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [detail.stdout, detail.stderr, detail.message]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n") || "Git command failed"
    );
  }
}

async function refreshGitIndex(cwd: string): Promise<void> {
  try {
    await git(cwd, ["update-index", "--really-refresh"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("needs update")) throw error;
  }
}

async function gitExists(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
