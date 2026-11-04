#!/usr/bin/env bash
set -euo pipefail

platform=${1:-}
[[ $# -eq 1 && "$platform" =~ ^(ios|android|all)$ ]] || {
  printf 'usage: native-bundle-rollback.sh <ios|android|all>\n' >&2
  exit 2
}
[[ $EUID -eq 0 ]] || { printf 'run native-bundle-rollback.sh as root on the VPS\n' >&2; exit 1; }

pointer=${ASH_ATLAS_NATIVE_BUNDLE_ROOT:-/srv/ash-atlas/native-bundles}/pointer.json
node - "$pointer" "$platform" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [pointerPath, selection] = process.argv.slice(2);
const selected = selection === "all" ? ["ios", "android"] : [selection];
const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
for (const platform of selected) {
  const entry = pointer[platform];
  if (!entry?.current || !entry.previous) {
    throw new Error(`${platform} has no previous native bundle to restore`);
  }
}
for (const platform of selected) {
  const entry = pointer[platform];
  [entry.current, entry.previous] = [entry.previous, entry.current];
}
const temporary = `${pointerPath}.rollback.${process.pid}`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o640, flag: "wx" });
  fs.chmodSync(temporary, 0o640);
  fs.chownSync(temporary, 0, fs.statSync(pointerPath).gid);
  fs.renameSync(temporary, pointerPath);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
process.stdout.write(`Native bundle pointer restored: ${selected.join(", ")}\n`);
NODE
