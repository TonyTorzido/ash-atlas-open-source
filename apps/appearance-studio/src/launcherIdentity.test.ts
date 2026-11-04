import { describe, expect, it } from "vitest";

import type {
  StudioServerIdentity,
  StudioSession,
  StudioWorkspaceStatus
} from "./bridgeTypes.js";
import {
  OFFICIAL_APPEARANCE_STUDIO_PORT,
  appearanceStudioPort,
  inspectStudioPort,
  studioCollisionMessage,
  verifyStudioProcess
} from "./launcherIdentity.js";

describe("Appearance Studio launcher identity", () => {
  it("reuses an exact same-worktree process", async () => {
    const expected = identity("C:\\worktrees\\appearance__t333", "abc", 30_101);
    const session = studioSession(expected, 4242);
    const result = await inspectStudioPort(expected, {
      fetchSession: async () => session,
      findListeningPid: async () => {
        throw new Error("PID lookup should not be needed");
      }
    });
    expect(result).toEqual({ kind: "reuse", session });
  });

  it("reports a different-worktree collision without stopping it", async () => {
    const expected = identity("C:\\worktrees\\expected__t333", "abc", 30_102);
    const actual = identity("C:\\worktrees\\other__t333", "def", 30_102);
    const result = await inspectStudioPort(expected, {
      fetchSession: async () => studioSession(actual, 5151),
      findListeningPid: async () => null
    });
    expect(result.kind).toBe("collision");
    if (result.kind !== "collision") return;
    expect(studioCollisionMessage(result)).toContain("PID 5151");
    expect(studioCollisionMessage(result)).toContain(
      "Expected worktree: C:\\worktrees\\expected__t333"
    );
    expect(studioCollisionMessage(result)).toContain(
      "Actual worktree: C:\\worktrees\\other__t333"
    );
    expect(studioCollisionMessage(result)).toContain("No process was stopped.");
  });

  it("reserves 5285 for the permanent official checkout and derives stable feature ports", () => {
    const official = workspace("C:\\repo", false);
    const feature = workspace("C:\\worktrees\\appearance__t333", true);
    expect(appearanceStudioPort(official)).toBe(OFFICIAL_APPEARANCE_STUDIO_PORT);
    expect(appearanceStudioPort(feature)).toBe(appearanceStudioPort(feature));
    expect(appearanceStudioPort(feature)).not.toBe(OFFICIAL_APPEARANCE_STUDIO_PORT);
    expect(appearanceStudioPort(feature)).not.toBe(
      appearanceStudioPort(workspace("C:\\worktrees\\other__t333", true))
    );
  });

  it("rejects a stale same-worktree process with its PID and actual commit", async () => {
    const expected = identity("C:\\worktrees\\appearance__t333", "newsha", 30_103);
    const stale = identity("C:\\worktrees\\appearance__t333", "oldsha", 30_103);
    const result = await inspectStudioPort(expected, {
      fetchSession: async () => studioSession(stale, 6161),
      findListeningPid: async () => null
    });
    expect(result.kind).toBe("collision");
    if (result.kind !== "collision") return;
    const message = studioCollisionMessage(result);
    expect(message).toContain("PID 6161");
    expect(message).toContain("fix/studio@newsha");
    expect(message).toContain("fix/studio@oldsha");
  });

  it("retries when its own listener is up before /api/session is ready", async () => {
    const expected = identity("C:\\worktrees\\appearance__t333", "abc", 30_104);
    const session = studioSession(expected, 6262);
    let probes = 0;
    const result = await verifyStudioProcess(expected, 6262, {
      attempts: 2,
      retryDelayMs: 0,
      fetchSession: async () => {
        probes += 1;
        return probes === 1 ? null : session;
      },
      findListeningPid: async () => 6262
    });
    expect(result).toEqual({ kind: "reuse", session });
    expect(probes).toBe(2);
  });

  it("does not retry a foreign listener reported on the expected port", async () => {
    const expected = identity("C:\\worktrees\\appearance__t333", "abc", 30_105);
    const foreign = identity("C:\\worktrees\\other__t333", "def", 30_105);
    let probes = 0;
    const result = await verifyStudioProcess(expected, 6263, {
      retryDelayMs: 0,
      fetchSession: async () => {
        probes += 1;
        return studioSession(foreign, 6263);
      },
      findListeningPid: async () => 6263
    });
    expect(result.kind).toBe("collision");
    expect(probes).toBe(1);
  });
});

function identity(
  worktreePath: string,
  commitSha: string,
  port: number
): Pick<StudioServerIdentity, "worktreePath" | "branch" | "commitSha" | "port"> {
  return { worktreePath, branch: "fix/studio", commitSha, port };
}

function studioSession(
  identityInput: Pick<
    StudioServerIdentity,
    "worktreePath" | "branch" | "commitSha" | "port"
  >,
  pid: number
): StudioSession {
  return {
    csrfToken: "token",
    origin: `http://127.0.0.1:${identityInput.port}`,
    workspace: workspace(identityInput.worktreePath, true),
    server: {
      ...identityInput,
      pid,
      startedAt: "2026-07-30T00:00:00.000Z"
    }
  };
}

function workspace(
  worktreePath: string,
  isLinkedWorktree: boolean
): StudioWorkspaceStatus {
  return {
    repositoryPath: worktreePath,
    worktreePath,
    branch: "fix/studio",
    commitSha: "abc",
    writesAllowed: isLinkedWorktree,
    writeBlockReason: isLinkedWorktree ? null : "protected",
    catalogRevision: 1,
    isLinkedWorktree,
    compatibility: {
      contractVersion: 4,
      supportedContractVersion: 5,
      minimumDesktopVersion: "1.3.0",
      compatible: true
    }
  };
}
