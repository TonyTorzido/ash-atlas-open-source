import { createRequire } from "node:module";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Downloads the DB-IP Lite City + ASN databases (CC BY 4.0, https://db-ip.com/db/lite.php),
// checks that they gunzip and open, then swaps them into TRUST_IPGEO_DIR atomically.
// Monthly files: dbip-city-lite-YYYY-MM.mmdb.gz and dbip-asn-lite-YYYY-MM.mmdb.gz.
// The server notices the swap within ~10 minutes; no restart is needed.
//
//   node tools/trust/update-ipgeo.mjs [--month YYYY-MM]
//
// TRUST_IPGEO_DIR defaults to apps/server/data/ipgeo (gitignored).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = resolve(process.env.TRUST_IPGEO_DIR?.trim() || resolve(root, "apps/server/data/ipgeo"));
const require = createRequire(resolve(root, "apps/server/package.json"));
const maxmind = require("maxmind");

const FILES = [
  { kind: "city", remote: "dbip-city-lite", local: "dbip-city-lite.mmdb" },
  { kind: "asn", remote: "dbip-asn-lite", local: "dbip-asn-lite.mmdb" }
];

function monthStamp(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function candidateMonths() {
  const argIndex = process.argv.indexOf("--month");
  if (argIndex > 0 && process.argv[argIndex + 1]) return [process.argv[argIndex + 1]];
  const now = new Date();
  // The new month's file can lag by a day or two: fall back to the previous month.
  return [monthStamp(now), monthStamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))];
}

async function download(url) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

await mkdir(directory, { recursive: true });
const staged = [];
try {
  let month = null;
  for (const candidate of candidateMonths()) {
    const buffers = [];
    for (const file of FILES) {
      buffers.push(await download(`https://download.db-ip.com/free/${file.remote}-${candidate}.mmdb.gz`));
    }
    if (buffers.every(Boolean)) {
      month = candidate;
      for (const [index, file] of FILES.entries()) {
        const database = gunzipSync(buffers[index]);
        const temporary = resolve(directory, `${file.local}.${process.pid}.tmp`);
        staged.push({ temporary, final: resolve(directory, file.local) });
        await writeFile(temporary, database);
        // Opening parses the metadata; a lookup proves the search tree is readable.
        const reader = await maxmind.open(temporary);
        reader.get("8.8.8.8");
        process.stdout.write(`${file.kind}: ${candidate} OK (${database.length} bytes)\n`);
      }
      break;
    }
  }
  if (!month) throw new Error("No DB-IP Lite files found for the current or previous month");
  for (const { temporary, final } of staged) await rename(temporary, final);
  staged.length = 0;
  process.stdout.write(`IP geolocation databases for ${month} installed in ${directory}\n`);
  process.stdout.write("IP geolocation by DB-IP.com (CC BY 4.0).\n");
} catch (error) {
  process.stderr.write(`update-ipgeo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const { temporary } of staged) await rm(temporary, { force: true });
}
