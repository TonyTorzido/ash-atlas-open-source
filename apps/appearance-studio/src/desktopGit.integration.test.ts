import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  createContentBatch,
  finishContentBatch,
  integrationWorktreePath
} from "./desktopGit.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Appearance Studio content batch Git integration", () => {
  it("selects the dedicated integration checkout instead of the permanent checkout", () => {
    const worktrees = [
      "worktree C:/repo/game",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/master",
      "",
      "worktree C:/repo/worktrees/integration-test",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/integration/test",
      ""
    ].join("\n");
    expect(integrationWorktreePath(worktrees))
      .toBe("C:/repo/worktrees/integration-test");
  });

  it("refuses a missing or ambiguous dedicated integration checkout", () => {
    expect(() => integrationWorktreePath([
      "worktree C:/repo/game",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/master"
    ].join("\n"))).toThrow("found 0");
    expect(() => integrationWorktreePath([
      "worktree C:/repo/first",
      "branch refs/heads/integration/test",
      "",
      "worktree C:/repo/second",
      "branch refs/heads/integration/test"
    ].join("\n"))).toThrow("found 2");
  });

  it("refreshes the permanent index before enforcing checkout cleanliness", async () => {
    const fixture = await repositoryFixture();
    const tracked = "packages/shared/src/data/player-appearance-catalog.json";
    await git(fixture.repository, ["update-index", "--assume-unchanged", tracked]);
    await writeFile(path.join(fixture.repository, tracked), '{"changed":true}\n');

    await expect(createContentBatch(fixture.repository, "Hidden Dirty Checkout"))
      .rejects.toThrow("permanent Ash Atlas checkout is dirty");
  }, 15_000);

  it("commits and pushes Studio-authored Game PNG and presentation content only", async () => {
    const fixture = await repositoryFixture();
    const created = await createContentBatch(fixture.repository, "Ember Weapons");
    expect(created).toMatchObject({
      branch: "feature/ember-weapons--from-t334",
      baseGeneration: "t334"
    });
    expect(created.worktreePath).toMatch(/ember-weapons__t334$/u);

    const png = "apps/client/src/assets/structures/EmberWell.PNG";
    const runtimeMetadata = "packages/shared/src/data/runtime-png-asset-metadata.json";
    const runtimeCatalog = "packages/shared/src/data/runtime-png-presentation.json";
    const progressionCatalog = "packages/shared/src/data/progression-icon-presentation.json";
    const manorCatalog = "packages/shared/src/data/interiors/manor_lobby.json";
    await mkdir(path.dirname(path.join(created.worktreePath, png)), { recursive: true });
    await writeFile(path.join(created.worktreePath, png), "png bytes");
    await writeFile(path.join(created.worktreePath, runtimeMetadata), '{"schemaVersion":1,"assets":{}}\n');
    await writeFile(path.join(created.worktreePath, runtimeCatalog), '{"schemaVersion":1}\n');
    await writeFile(path.join(created.worktreePath, progressionCatalog), '{"schemaVersion":1}\n');
    await writeFile(path.join(created.worktreePath, manorCatalog), '{"schemaVersion":3}\n');
    await writeFile(path.join(created.worktreePath, "__MERGED_TO_TEST__.md"), "receipt\n");
    const finished = await finishContentBatch(created.worktreePath, "add ember weapons");
    expect(finished).toMatchObject({
      branch: created.branch,
      changedFiles: [png, manorCatalog, progressionCatalog, runtimeMetadata, runtimeCatalog],
      pushed: true
    });
    const remote = await git(created.worktreePath, [
      "ls-remote", "--heads", "origin", `refs/heads/${created.branch}`
    ]);
    expect(remote.startsWith(`${finished.commitSha}\t`)).toBe(true);
    expect(await git(created.worktreePath, ["status", "--short"]))
      .toBe("?? __MERGED_TO_TEST__.md\n");
  }, 15_000);

  it("recovers a local Studio commit when the first push was interrupted", async () => {
    const fixture = await repositoryFixture();
    const created = await createContentBatch(fixture.repository, "Interrupted Push");
    const png = "apps/client/src/assets/structures/InterruptedWell.PNG";
    await mkdir(path.dirname(path.join(created.worktreePath, png)), { recursive: true });
    await writeFile(path.join(created.worktreePath, png), "png bytes");
    await git(created.worktreePath, ["add", png]);
    await git(created.worktreePath, ["commit", "-m", "feat(appearance): interrupted push"]);

    const finished = await finishContentBatch(created.worktreePath, "retry interrupted push");
    expect(finished).toMatchObject({
      branch: created.branch,
      changedFiles: [png],
      pushed: true
    });
    const remote = await git(created.worktreePath, [
      "ls-remote", "--heads", "origin", `refs/heads/${created.branch}`
    ]);
    expect(remote.startsWith(`${finished.commitSha}\t`)).toBe(true);
  }, 15_000);

  it("refuses and leaves unstaged a non-PNG file under a runtime asset root", async () => {
    const fixture = await repositoryFixture();
    const created = await createContentBatch(fixture.repository, "Runtime Config");
    const headBefore = (await git(created.worktreePath, ["rev-parse", "HEAD"])).trim();
    const unrelated = "apps/client/public/runtime-config.json";
    await mkdir(path.dirname(path.join(created.worktreePath, unrelated)), { recursive: true });
    await writeFile(path.join(created.worktreePath, unrelated), "{}\n");

    await expect(finishContentBatch(created.worktreePath, "change runtime config"))
      .rejects.toThrow(`refused to stage them: ${unrelated}`);
    expect((await git(created.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect(await git(created.worktreePath, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await git(created.worktreePath, [
      "status", "--short", "--untracked-files=all"
    ]))
      .toBe(`?? ${unrelated}\n`);
  }, 15_000);
});

async function repositoryFixture(): Promise<{ repository: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ash-studio-desktop-git-"));
  roots.push(root);
  const repository = path.join(root, "game");
  const origin = path.join(root, "origin.git");
  await mkdir(repository, { recursive: true });
  await git(root, ["init", "--bare", origin]);
  await git(repository, ["init", "-b", "integration/test"]);
  await git(repository, ["config", "user.email", "studio@example.com"]);
  await git(repository, ["config", "user.name", "Studio Test"]);
  await git(repository, ["remote", "add", "origin", origin]);
  await writeFixtureFiles(repository);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "test fixture"]);
  await git(repository, ["tag", "test/t334"]);
  await git(repository, ["push", "--set-upstream", "origin", "integration/test"]);
  await git(repository, ["push", "origin", "test/t334"]);
  return { repository };
}

async function writeFixtureFiles(repository: string): Promise<void> {
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "config/appearance-studio.compatibility.json":
      '{"contractVersion":8,"minimumDesktopVersion":"1.8.0"}\n',
    "packages/shared/src/data/player-appearance-catalog.json": "{}\n",
    "packages/shared/src/data/boss-appearance-catalog.json": "{}\n",
    "packages/shared/src/data/item-variant-catalog.json": "{}\n",
    "packages/shared/src/data/interiors/manor_lobby.json": "{}\n",
    "packages/shared/src/data/runtime-png-presentation.json": "{}\n",
    "packages/shared/src/data/progression-icon-presentation.json": "{}\n",
    "packages/player-renderer/src/assets/player-appearance/.gitkeep": "",
    "packages/player-renderer/src/assets/boss-appearance/.gitkeep": ""
  };
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(repository, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  return result.stdout;
}
