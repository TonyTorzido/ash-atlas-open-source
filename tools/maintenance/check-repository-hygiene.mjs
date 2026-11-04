import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"));
const failures = [];
const rootCmd = tracked.filter((file) => !file.includes("/") && file.toLowerCase().endsWith(".cmd"));
const rootBat = tracked.filter((file) => !file.includes("/") && file.toLowerCase().endsWith(".bat"));

if (rootCmd.length !== 1 || rootCmd[0] !== "Run Ash Atlas.cmd") {
  failures.push(`root launcher policy requires only 'Run Ash Atlas.cmd'; found: ${rootCmd.join(", ") || "none"}`);
}
if (rootBat.length) failures.push(`root .bat files are forbidden: ${rootBat.join(", ")}`);

const forbidden = tracked.filter((file) =>
  /^(reports|logs?|tmp|temp|artifacts?|coverage|dist|world-packages-v1)(\/|$)/i.test(file) ||
  /(^|\/)(owned-processes|identity)\.json$/i.test(file) ||
  /\.(log|pid|sqlite3?|db|dump)$/i.test(file),
);
if (forbidden.length) failures.push(`generated or temporary files are tracked: ${forbidden.join(", ")}`);

if (failures.length) {
  console.error(failures.map((failure) => `HYGIENE: ${failure}`).join("\n"));
  process.exit(1);
}
console.log("Repository hygiene passed: one canonical launcher and no tracked generated artifacts.");
