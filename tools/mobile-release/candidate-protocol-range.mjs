import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export function readCandidateProtocolRange(sourceRoot, sourceSha) {
  const path = resolve(sourceRoot, "config/protocol-versions.json");
  if (sourceSha !== undefined && !/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("candidate source SHA must be exact");
  const source = sourceSha ? execFileSync("git", ["show", `${sourceSha}:config/protocol-versions.json`],
    { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) : readFileSync(path, "utf8");
  const config = JSON.parse(source);
  const min = config?.min_protocol;
  const max = config?.max_protocol;
  if (config?.protocol_id !== "ash-atlas" || !Number.isInteger(min) || !Number.isInteger(max) ||
      min <= 0 || max < min || max > 1_000_000) {
    throw new Error("candidate protocol configuration is invalid");
  }
  return { min, max, source: path };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sourceRoot = process.argv[2] ?? process.cwd();
  const range = readCandidateProtocolRange(sourceRoot, process.argv[3]);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `protocol_min=${range.min}\nprotocol_max=${range.max}\n`, {
      flag: "a"
    });
  }
  process.stdout.write(`${JSON.stringify(range)}\n`);
}
