import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyMobileImpact, isMobileAffectedPath, isPlatformAffectedPath } from "./classify-mobile-impact.mjs";

test("classifies native, shared client, renderer, auth, and Capacitor paths", () => {
  for (const path of [
    "apps/client/src/App.tsx",
    "packages/shared/src/protocol.ts",
    "packages/player-renderer/src/index.ts",
    "apps/server/src/auth/nativeAppRoutes.ts",
    "apps/server/src/config.ts",
    "ios/App/App/Info.plist",
    "android/app/build.gradle",
    "capacitor.config.ts",
    "pnpm-lock.yaml"
  ]) assert.equal(isMobileAffectedPath(path), true, path);
});

test("leaves isolated server and documentation changes unaffected", () => {
  assert.equal(isMobileAffectedPath("apps/server/src/game/combat.ts"), false);
  assert.equal(isMobileAffectedPath("docs/gameplay/combat.md"), false);
});

test("classifies each platform from its last distributed source across interleaved server generations", () => {
  const root = mkdtempSync(join(tmpdir(), "mobile-impact-history-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args], { cwd: root });
  try {
    git("init", "--quiet", "-b", "main");
    writeFileSync(join(root, "README.md"), "base\n");
    git("add", "."); git("commit", "--quiet", "-m", "base");
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    mkdirSync(join(root, "apps", "server", "src", "game"), { recursive: true });
    writeFileSync(join(root, "apps", "server", "src", "game", "combat.ts"), "server-only\n");
    git("add", "."); git("commit", "--quiet", "-m", "server-only");
    const serverOnly = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    mkdirSync(join(root, "ios"));
    writeFileSync(join(root, "ios", "change.txt"), "ios\n");
    git("add", "."); git("commit", "--quiet", "-m", "ios-change");
    const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = classifyMobileImpact({ root, target, baselines: { ios: baseline, android: serverOnly } });
    assert.equal(result.platformsResult.ios.classification, "MOBILE_SHARED_CLIENT_AFFECTED");
    assert.equal(result.platformsResult.android.classification, "MOBILE_UNAFFECTED");
    assert.ok(result.platformsResult.ios.changedPaths.includes("apps/server/src/game/combat.ts"));
    assert.deepEqual(result.baselines, { ios: baseline, android: serverOnly });
    assert.equal(isPlatformAffectedPath("ios/change.txt", "android"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
