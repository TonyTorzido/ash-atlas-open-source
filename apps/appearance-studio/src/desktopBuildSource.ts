import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DesktopBuildSource = {
  branch: string | null;
  commitSha: string;
  integrationSha: string | null;
  generationTags: string[];
  clean: boolean;
};

export async function inspectDesktopBuildSource(
  repositoryRoot: string
): Promise<DesktopBuildSource> {
  const [branch, commitSha, integrationSha, tags, status] = await Promise.all([
    git(repositoryRoot, ["branch", "--show-current"]),
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["rev-parse", "refs/remotes/origin/integration/test"], true),
    git(repositoryRoot, ["tag", "--points-at", "HEAD", "--list", "test/t*"]),
    git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  return {
    branch: branch.trim() || null,
    commitSha: commitSha.trim().toLowerCase(),
    integrationSha: integrationSha.trim().toLowerCase() || null,
    generationTags: tags.split(/\r?\n/u).map((tag) => tag.trim()).filter(Boolean),
    clean: status.trim().length === 0
  };
}

export function desktopReleaseSourceProblem(source: DesktopBuildSource): string | null {
  if (source.branch !== "integration/test") {
    return "Installable Appearance Studio packages must be built from integration/test.";
  }
  if (!source.clean) {
    return "Installable Appearance Studio packages require a clean integration/test worktree.";
  }
  if (!source.integrationSha || source.commitSha !== source.integrationSha) {
    return "Local integration/test must exactly match origin/integration/test before packaging.";
  }
  if (source.generationTags.length !== 1) {
    return "The packaged integration/test SHA must have exactly one immutable generation tag.";
  }
  return null;
}

export function assertDesktopReleaseSource(source: DesktopBuildSource): void {
  const problem = desktopReleaseSourceProblem(source);
  if (problem) throw new Error(problem);
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
    return result.stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}
