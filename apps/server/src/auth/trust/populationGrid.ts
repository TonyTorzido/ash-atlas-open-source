import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { AppLogger } from "../../logger.js";

// Population alert zones (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 4.1).
// The grid is built offline by tools/trust/build-population-grid.mjs from GHSL
// GHS-POP R2023A (CC BY 4.0, see THIRD_PARTY_DATA.md). A missing or corrupt grid
// never blocks anything: every point classifies as "urban" (no alert) and one
// warning is logged.

export type PopulationClass = "red" | "orange" | "rural" | "urban";

const CLASS_BY_VALUE: readonly PopulationClass[] = ["red", "orange", "rural", "urban"];
const GRID_FILE = "population-grid-v1.bin.gz";
const HEADER_FILE = "population-grid-v1.json";

type GridHeader = Readonly<{ version: number; cellDegrees: number; cols: number; rows: number; rawBytes: number; sha256: string }>;
type LoadedGrid = Readonly<{ header: GridHeader; cells: Uint8Array }>;

export type PopulationGridOptions = Readonly<{
  // Directories searched in order for the grid + header. Defaults cover the
  // source tree (src/auth/trust), the esbuild artifact (dist/data) and the
  // process working directory (repo root or apps/server).
  directories?: readonly string[];
  logger?: Pick<AppLogger, "warn"> | undefined;
}>;

export type PopulationGrid = Readonly<{
  classify(lat: number, lon: number): PopulationClass;
  // True when the real grid is loaded (false means the "urban" fallback).
  isAvailable(): boolean;
}>;

export function defaultPopulationGridDirectories(): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const cwd = process.cwd();
  return [
    resolve(moduleDirectory, "data"),
    resolve(moduleDirectory, "../../../data"),
    resolve(cwd, "data"),
    resolve(cwd, "apps/server/data"),
    resolve(cwd, "apps/server/dist/data")
  ];
}

function readHeader(raw: string): GridHeader {
  const parsed = JSON.parse(raw) as Partial<Record<keyof GridHeader, unknown>>;
  const { version, cellDegrees, cols, rows, rawBytes, sha256 } = parsed;
  if (
    version !== 1 || typeof cellDegrees !== "number" || typeof cols !== "number" || typeof rows !== "number"
    || typeof rawBytes !== "number" || typeof sha256 !== "string"
    || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0
    || cols * rows !== rawBytes
  ) {
    throw new Error("population grid header is invalid");
  }
  return { version, cellDegrees, cols, rows, rawBytes, sha256 };
}

function loadGrid(directories: readonly string[]): LoadedGrid {
  const directory = directories.find((candidate) =>
    existsSync(resolve(candidate, GRID_FILE)) && existsSync(resolve(candidate, HEADER_FILE))
  );
  if (!directory) throw new Error(`population grid not found (searched ${directories.join(", ")})`);
  const header = readHeader(readFileSync(resolve(directory, HEADER_FILE), "utf8"));
  const cells = gunzipSync(readFileSync(resolve(directory, GRID_FILE)));
  if (cells.length !== header.rawBytes) throw new Error("population grid size does not match its header");
  if (createHash("sha256").update(cells).digest("hex") !== header.sha256) {
    throw new Error("population grid sha256 does not match its header");
  }
  return { header, cells };
}

export function createPopulationGrid(options: PopulationGridOptions = {}): PopulationGrid {
  let state: LoadedGrid | null | undefined;
  const load = (): LoadedGrid | null => {
    if (state !== undefined) return state;
    try {
      state = loadGrid(options.directories ?? defaultPopulationGridDirectories());
    } catch (error) {
      state = null;
      options.logger?.warn(
        { err: error },
        "Population grid unavailable; alert zones classify every location as urban"
      );
    }
    return state;
  };
  return {
    isAvailable: () => load() !== null,
    classify(lat, lon) {
      const grid = load();
      if (!grid || !Number.isFinite(lat) || !Number.isFinite(lon)) return "urban";
      const { cellDegrees, cols, rows } = grid.header;
      const row = Math.min(rows - 1, Math.max(0, Math.floor((90 - lat) / cellDegrees)));
      const col = ((Math.floor((lon + 180) / cellDegrees) % cols) + cols) % cols;
      return CLASS_BY_VALUE[grid.cells[row * cols + col] ?? 3] ?? "urban";
    }
  };
}

let sharedGrid: PopulationGrid | null = null;

// Process-wide lazy grid. Pass the logger from the startup path (or any first
// caller) so a missing file is reported once.
export function getPopulationGrid(logger?: PopulationGridOptions["logger"]): PopulationGrid {
  sharedGrid ??= createPopulationGrid({ logger });
  return sharedGrid;
}

export function classifyPopulation(lat: number, lon: number): PopulationClass {
  return getPopulationGrid().classify(lat, lon);
}
