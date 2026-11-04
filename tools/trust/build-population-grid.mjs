#!/usr/bin/env node
// Builds apps/server/data/population-grid-v1.bin.gz (+ .json header) from the
// GHSL GHS-POP R2023A 30 arc-second, epoch 2025, WGS84 (EPSG:4326) GeoTIFF.
// Manual tool (not CI). See docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 4.1.
//
//   node tools/trust/build-population-grid.mjs [--source <zip-or-tif>] [--cache <dir>]
//
// Without --source it downloads the official JRC zip (~480 MB) into
// tools/trust/.cache/ (gitignored) and reuses it on later runs. The raw data is
// never committed; only the derived 0.05 degree class grid is.
//
// Grid: 7200 x 3600 cells of 0.05 degrees, row 0 = north (lat 90..89.95), column
// 0 = west (lon -180..-179.95), one byte per cell = class of the population sum
// of the cell plus its 8 neighbours (longitude wraps, latitude clamps):
//   0 red (< 1 person; nodata counts as 0), 1 orange (< 200), 2 rural (< 20000), 3 urban.
// Source: Schiavina M., Freire S., Carioli A., MacManus K. (2023), GHS-POP R2023A,
// European Commission JRC, doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE. CC BY 4.0.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { fromFile } from "geotiff";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_30ss/V1-0/GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.zip";
const SOURCE_PAGE = "https://ghsl.jrc.ec.europa.eu/ghs_pop2023.php";

const CELL_DEGREES = 0.05;
const COLS = 7200;
const ROWS = 3600;
const ORANGE_MAX_PEOPLE = 200;
const URBAN_MIN_PEOPLE = 20_000;
const RED_MAX_PEOPLE = 1;
const CHUNK_PIXEL_ROWS = 1200;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function download(url, target) {
  const existing = await stat(target).catch(() => null);
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD ${url} failed: ${head.status}`);
  const expected = Number(head.headers.get("content-length"));
  if (existing && existing.size === expected) return;
  process.stdout.write(`Downloading ${url} (${(expected / 1e6).toFixed(0)} MB)\n`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`GET ${url} failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

function extractTiff(zipPath, directory) {
  const attempts = [
    ["tar", ["-xf", zipPath, "-C", directory]],
    ["unzip", ["-o", zipPath, "-d", directory]]
  ];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status === 0) return;
  }
  throw new Error(`Could not extract ${zipPath}; extract the .tif by hand and pass --source <tif>.`);
}

async function resolveTiff() {
  const cacheDirectory = resolve(argument("--cache") ?? join(repositoryRoot, "tools/trust/.cache"));
  await mkdir(cacheDirectory, { recursive: true });
  let source = argument("--source");
  if (!source) {
    source = join(cacheDirectory, "ghs-pop-e2025-30ss.zip");
    await download(SOURCE_URL, source);
  }
  if (source.toLowerCase().endsWith(".tif")) return source;
  const extracted = join(cacheDirectory, "extracted");
  await mkdir(extracted, { recursive: true });
  let tif = (await readdir(extracted)).find((name) => name.toLowerCase().endsWith(".tif"));
  if (!tif) {
    extractTiff(source, extracted);
    tif = (await readdir(extracted)).find((name) => name.toLowerCase().endsWith(".tif"));
  }
  if (!tif) throw new Error(`No .tif found in ${source}`);
  return join(extracted, tif);
}

function classOf(people) {
  if (people < RED_MAX_PEOPLE) return 0;
  if (people < ORANGE_MAX_PEOPLE) return 1;
  if (people < URBAN_MIN_PEOPLE) return 2;
  return 3;
}

async function main() {
  const tifPath = await resolveTiff();
  process.stdout.write(`Reading ${tifPath}\n`);
  const tiff = await fromFile(tifPath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [west, south, east, north] = image.getBoundingBox();
  const noData = image.getGDALNoData();
  // The product is 30 arc-second (1/120 degree) pixels covering roughly lat +-89.1 and
  // lon +-180 with a sub-pixel edge overhang, so pixels are assigned to cells by their
  // centre coordinates. Rows beyond the raster (the poles) stay at zero population.
  const pixelWidth = (east - west) / width;
  const pixelHeight = (north - south) / height;
  if (
    Math.abs(pixelWidth * 120 - 1) > 0.01 || Math.abs(pixelHeight * 120 - 1) > 0.01
    || west > -179.9 || east < 179.9 || north < 80 || south > -80
  ) {
    throw new Error(`Unexpected raster geometry ${width}x${height} bbox [${west},${south},${east},${north}]; expected a near-global WGS84 30 arc-second grid`);
  }
  const columnCell = new Int32Array(width);
  for (let c = 0; c < width; c += 1) {
    const lon = west + (c + 0.5) * pixelWidth;
    columnCell[c] = Math.min(COLS - 1, Math.max(0, Math.floor((lon + 180) / CELL_DEGREES)));
  }

  // Population sum per 0.05 degree cell. Float64 keeps the sums exact enough.
  const sums = new Float64Array(COLS * ROWS);
  for (let pixelTop = 0; pixelTop < height; pixelTop += CHUNK_PIXEL_ROWS) {
    const pixelBottom = Math.min(height, pixelTop + CHUNK_PIXEL_ROWS);
    const [band] = await image.readRasters({ window: [0, pixelTop, width, pixelBottom], samples: [0] });
    for (let r = pixelTop; r < pixelBottom; r += 1) {
      const lat = north - (r + 0.5) * pixelHeight;
      const cellRow = Math.min(ROWS - 1, Math.max(0, Math.floor((90 - lat) / CELL_DEGREES)));
      const sumRow = cellRow * COLS;
      const base = (r - pixelTop) * width;
      for (let c = 0; c < width; c += 1) {
        const value = band[base + c];
        // nodata (the product uses a large negative value over the oceans) counts as 0.
        if (!(value > 0) || value === noData) continue;
        sums[sumRow + columnCell[c]] += value;
      }
    }
    process.stdout.write(`  pixel rows ${pixelBottom}/${height}
`);
  }

  const grid = new Uint8Array(COLS * ROWS);
  const counts = [0, 0, 0, 0];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      let total = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        const rr = row + dr;
        if (rr < 0 || rr >= ROWS) continue;
        for (let dc = -1; dc <= 1; dc += 1) {
          total += sums[rr * COLS + ((col + dc + COLS) % COLS)];
        }
      }
      const cls = classOf(total);
      grid[row * COLS + col] = cls;
      counts[cls] += 1;
    }
  }

  const raw = Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const gz = gzipSync(raw, { level: 9 });
  const dataDirectory = resolve(repositoryRoot, "apps/server/data");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "population-grid-v1.bin.gz"), gz);
  const header = {
    version: 1,
    file: "population-grid-v1.bin.gz",
    source: "GHSL GHS-POP R2023A, 30 arc-second, WGS84 (EPSG:4326), GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0",
    sourceUrl: SOURCE_PAGE,
    epoch: 2025,
    license: "CC BY 4.0",
    attribution: "Schiavina M., Freire S., Carioli A., MacManus K. (2023): GHS-POP R2023A. European Commission, Joint Research Centre (JRC). doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE",
    cellDegrees: CELL_DEGREES,
    cols: COLS,
    rows: ROWS,
    layout: "row-major, one byte per cell, row 0 = north (lat 90), column 0 = west (lon -180)",
    window: "cell plus 8 neighbours",
    classes: { 0: "red", 1: "orange", 2: "rural", 3: "urban" },
    thresholds: { redBelow: RED_MAX_PEOPLE, orangeBelow: ORANGE_MAX_PEOPLE, urbanAtLeast: URBAN_MIN_PEOPLE },
    cellCounts: { red: counts[0], orange: counts[1], rural: counts[2], urban: counts[3] },
    rawBytes: raw.length,
    sha256,
    sha256Of: "gunzipped grid bytes"
  };
  await writeFile(join(dataDirectory, "population-grid-v1.json"), `${JSON.stringify(header, null, 2)}\n`);
  process.stdout.write(`Wrote population-grid-v1.bin.gz (${gz.length} bytes) sha256 ${sha256}\n`);
  process.stdout.write(`Cells: ${JSON.stringify(header.cellCounts)}\n`);
}

await main();
