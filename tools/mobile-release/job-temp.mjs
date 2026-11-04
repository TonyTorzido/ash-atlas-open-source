import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { requireState } from "./store-api.mjs";

const hostState = join(homedir(), "Library", "Application Support", "AshAtlasRelease");
const quarantine = join(hostState, "cleanup-required.json");
const security = (args) => execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const paths = (text) => text.trim().split("\n").map((s) => s.trim().replace(/^"|"$/gu, "")).filter(Boolean);

export function cleanupJob(env, run = security, stateFile = quarantine) {
  const directory = resolve(env.ASH_ATLAS_JOB_TEMP);
  requireState(basename(directory).startsWith("ash-atlas-mobile-") && directory !== resolve(env.RUNNER_TEMP), "Invalid cleanup directory");
  const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
  requireState(owner.run === env.GITHUB_RUN_ID && owner.job === env.GITHUB_JOB, "Cleanup ownership mismatch");
  const failures = [];
  const attempt = (label, action) => { try { action(); } catch { failures.push(label); } };
  let original, defaultKeychain;
  if (existsSync(join(directory, "original-keychains.txt"))) {
    original = paths(readFileSync(join(directory, "original-keychains.txt"), "utf8"));
    attempt("read original default keychain", () => { defaultKeychain = paths(readFileSync(join(directory, "original-default-keychain.txt"), "utf8"))[0]; });
    attempt("restore keychain search list", () => run(["list-keychains", "-d", "user", "-s", ...original]));
    attempt("restore default keychain", () => { requireState(defaultKeychain, "Missing original default"); run(["default-keychain", "-d", "user", "-s", defaultKeychain]); });
  }
  const keychain = join(directory, "signing.keychain-db");
  if (existsSync(keychain)) attempt("delete job signing keychain", () => { run(["delete-keychain", keychain]); requireState(!existsSync(keychain), "Keychain still exists"); });
  if (original) {
    attempt("verify keychain search list", () => requireState(JSON.stringify(paths(run(["list-keychains", "-d", "user"]))) === JSON.stringify(original), "Search list differs"));
    attempt("verify default keychain", () => requireState(paths(run(["default-keychain", "-d", "user"]))[0] === defaultKeychain, "Default differs"));
  }
  if (env.ASH_ATLAS_PROFILE_CREATED === "true") attempt("remove job provisioning profile", () => {
    const profile = resolve(env.ASH_ATLAS_PROFILE_PATH);
    requireState(profile.startsWith(join(homedir(), "Library/MobileDevice/Provisioning Profiles") + "/"), "Unexpected profile path");
    if (existsSync(profile)) {
      requireState(readFileSync(profile).equals(readFileSync(join(directory, "profile.mobileprovision"))), "Profile changed after installation");
      rmSync(profile);
    }
  });
  if (env.SIGNING_VALIDATION === "true" && ["ios", "android"].includes(env.GITHUB_JOB)) attempt("remove validation artifacts", () => {
    const workspace = resolve(env.GITHUB_WORKSPACE);
    requireState(workspace !== "/", "Invalid workspace");
    rmSync(join(workspace, "artifacts", env.GITHUB_JOB), { recursive: true, force: true });
    if (env.GITHUB_JOB === "android") rmSync(join(workspace, "android/app/build/outputs/bundle/release"), { recursive: true, force: true });
  });
  if (!failures.length) attempt("remove job temporary files", () => rmSync(directory, { recursive: true }));
  if (failures.length) {
    writeFileSync(stateFile, JSON.stringify({ directory, run: owner.run, job: owner.job, failures }), { mode: 0o600 });
    throw new Error(`Host cleanup failed: ${failures.join(", ")}. Runner reuse is blocked until owner recovery: ${stateFile}`);
  }
  if (existsSync(stateFile)) {
    requireState(JSON.parse(readFileSync(stateFile, "utf8")).directory === directory, "Runner recovery marker ownership mismatch");
    rmSync(stateFile);
  }
}

function main() {
  if (process.argv[2] === "init") {
    requireState(!existsSync(quarantine), `Runner reuse blocked by unresolved cleanup: ${quarantine}`);
    const directory = mkdtempSync(join(process.env.RUNNER_TEMP, "ash-atlas-mobile-"));
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "owner.json"), JSON.stringify({ run: process.env.GITHUB_RUN_ID, job: process.env.GITHUB_JOB }), { mode: 0o600 });
    mkdirSync(hostState, { recursive: true, mode: 0o700 });
    // Persist before any signing work. Cancellation or a killed runner also prevents reuse.
    writeFileSync(quarantine, JSON.stringify({ directory, run: process.env.GITHUB_RUN_ID, job: process.env.GITHUB_JOB,
      failures: ["Job cleanup has not completed"] }), { mode: 0o600, flag: "wx" });
    appendFileSync(process.env.GITHUB_ENV, `ASH_ATLAS_JOB_TEMP=${directory}\n`);
    return;
  }
  requireState(process.argv[2] === "cleanup", "usage: job-temp.mjs init|cleanup");
  if (process.env.ASH_ATLAS_JOB_TEMP) cleanupJob(process.env);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
