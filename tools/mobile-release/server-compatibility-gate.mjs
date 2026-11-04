import { readFileSync } from "node:fs";

import { supportedReleases, validateRegistry } from "./registry.mjs";

const args = parseArgs(process.argv.slice(2));
const registry = validateRegistry(JSON.parse(readFileSync(required(args, "registry"), "utf8")));
const serverProtocol = {
  min: Number(required(args, "protocol-min")),
  max: Number(required(args, "protocol-max"))
};
const hardMinimum = {
  ios: {
    version: String(args["ios-hard-version"] ?? process.env.NATIVE_IOS_HARD_MIN_VERSION ?? "0.0.0"),
    build: Number(args["ios-hard-build"] ?? process.env.NATIVE_IOS_HARD_MIN_BUILD ?? 0)
  },
  android: {
    version: String(args["android-hard-version"] ?? process.env.NATIVE_ANDROID_HARD_MIN_VERSION ?? "0.0.0"),
    build: Number(args["android-hard-build"] ?? process.env.NATIVE_ANDROID_HARD_MIN_BUILD ?? 0)
  }
};
if (!Number.isInteger(serverProtocol.min) || !Number.isInteger(serverProtocol.max) ||
    serverProtocol.min <= 0 || serverProtocol.min > serverProtocol.max) {
  throw new Error("server protocol range is invalid");
}
for (const [platform, minimum] of Object.entries(hardMinimum)) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(minimum.version) ||
      !Number.isInteger(minimum.build) || minimum.build < 0) {
    throw new Error(`${platform} hard minimum is invalid`);
  }
}
const failures = [];
for (const release of supportedReleases(registry)) {
  if (release.protocol.max < serverProtocol.min || release.protocol.min > serverProtocol.max) {
    failures.push(`${release.platform} ${release.marketingVersion} (${release.build}) protocol ` +
      `${release.protocol.min}-${release.protocol.max} cannot use server ${serverProtocol.min}-${serverProtocol.max}`);
  }
  if (compareRelease(release.marketingVersion, release.build,
    hardMinimum[release.platform].version, hardMinimum[release.platform].build) < 0) {
    failures.push(`${release.platform} ${release.marketingVersion} (${release.build}) is below ` +
      `configured hard minimum ${hardMinimum[release.platform].version} ` +
      `(${hardMinimum[release.platform].build})`);
  }
}
if (failures.length > 0) {
  throw new Error(`server would break supported tester builds:\n${failures.join("\n")}`);
}
process.stdout.write(`${JSON.stringify({ checked: supportedReleases(registry).length, status: "compatible" })}\n`);

function compareRelease(leftVersion, leftBuild, rightVersion, rightBuild) {
  const left = leftVersion.split(/[.-]/u).slice(0, 3).map(Number);
  const right = rightVersion.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return leftBuild - rightBuild;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return String(value);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    result[values[index].replace(/^--/u, "")] = values[index + 1];
  }
  return result;
}
