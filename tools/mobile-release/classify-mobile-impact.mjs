import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export function isMobileAffectedPath(path) {
  return isPlatformAffectedPath(path, "ios") || isPlatformAffectedPath(path, "android");
}

export function isPlatformAffectedPath(path, platform) {
  if (!["ios", "android"].includes(platform)) throw new Error(`invalid mobile platform: ${platform}`);
  if (/^(?:apps\/client\/|packages\/(?:shared|player-renderer)\/|apps\/server\/src\/(?:auth\/|config\.ts$)|fastlane\/|tools\/mobile-release\/)/u.test(path) ||
      /^(?:capacitor\.config\.ts|package\.json|pnpm-lock\.yaml|Gemfile(?:\.lock)?)$/u.test(path)) return true;
  return platform === "ios" ? /^ios\//u.test(path) : /^android\//u.test(path);
}

export function classifyMobileImpact({
  root = process.cwd(),
  target,
  baselines,
  platforms = ["ios", "android"],
  override = "auto"
}) {
  if (!target) throw new Error("target is required");
  if (!["auto", "force-affected", "force-unaffected"].includes(override)) {
    throw new Error("override must be auto, force-affected, or force-unaffected");
  }
  const selected = [...new Set(platforms)];
  if (selected.length === 0 || selected.some((platform) => !["ios", "android"].includes(platform))) {
    throw new Error("platforms must contain ios and/or android");
  }
  const result = { target, override, platforms: selected, baselines: {}, platformsResult: {} };
  for (const platform of selected) {
    const base = baselines?.[platform];
    if (!base) throw new Error(`${platform} distributed source baseline is required`);
    const changed = changedPaths(root, base, target);
    const matched = changed.filter((path) => isPlatformAffectedPath(path, platform));
    const classification = override === "force-affected"
      ? "MOBILE_SHARED_CLIENT_AFFECTED"
      : override === "force-unaffected"
        ? "MOBILE_UNAFFECTED"
        : matched.length > 0
          ? "MOBILE_SHARED_CLIENT_AFFECTED"
          : "MOBILE_UNAFFECTED";
    result.baselines[platform] = base;
    result.platformsResult[platform] = {
      classification,
      base,
      target,
      changedPaths: changed,
      matchedPaths: matched
    };
  }
  result.classification = selected.some((platform) =>
    result.platformsResult[platform].classification === "MOBILE_SHARED_CLIENT_AFFECTED")
    ? "MOBILE_SHARED_CLIENT_AFFECTED" : "MOBILE_UNAFFECTED";
  result.changedPaths = [...new Set(selected.flatMap((platform) => result.platformsResult[platform].changedPaths))];
  result.matchedPaths = [...new Set(selected.flatMap((platform) => result.platformsResult[platform].matchedPaths))];
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const override = args.override ?? "auto";
  const platforms = String(args.platforms ?? "ios,android").split(",").filter(Boolean);
  const target = required(args, "target");
  const legacyBase = args.base;
  const baselines = {
    ios: args["ios-base"] ?? legacyBase,
    android: args["android-base"] ?? legacyBase
  };
  const result = classifyMobileImpact({ target, baselines, platforms, override });
  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `classification=${result.classification}`,
      `affected=${result.classification === "MOBILE_SHARED_CLIENT_AFFECTED"}`
    ];
    for (const platform of ["ios", "android"]) {
      const entry = result.platformsResult[platform];
      if (!entry) continue;
      lines.push(`${platform}_classification=${entry.classification}`);
      lines.push(`${platform}_affected=${entry.classification === "MOBILE_SHARED_CLIENT_AFFECTED"}`);
      lines.push(`${platform}_base=${entry.base}`);
    }
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, { flag: "a" });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function changedPaths(root, baseRevision, targetRevision) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB",
    `${baseRevision}..${targetRevision}`], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/u).map((path) => path.trim()).filter(Boolean);
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return String(value);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    result[value.slice(2)] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return result;
}
