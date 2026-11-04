// Builds the store binary's seed bundle (see nativeSeedBundle.ts) into the
// client's dist/, the Capacitor webDir. OTA bundles are built separately by
// tools/release/build-native-bundles.mjs and always carry the full client.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

const modes = { ios: "capacitor", android: "capacitor-android" };
const platform = process.argv[2];
if (!Object.hasOwn(modes, platform)) {
  process.stderr.write("usage: buildNativeSeedBundle.mjs <ios|android>\n");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const vitePackage = require.resolve("vite/package.json");
const viteBin = join(dirname(vitePackage), JSON.parse(readFileSync(vitePackage, "utf8")).bin.vite);
const result = spawnSync(process.execPath, [viteBin, "build", "--mode", modes[platform]], {
  stdio: "inherit",
  env: { ...process.env, VITE_NATIVE_SEED_BUNDLE: "true" }
});
process.exit(result.status ?? 1);
