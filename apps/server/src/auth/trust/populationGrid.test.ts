import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPopulationGrid, defaultPopulationGridDirectories } from "./populationGrid.js";

const DATA_DIRECTORY = path.resolve(import.meta.dirname, "../../../data");
const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "population-grid-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("population grid classification fixtures (GHS-POP R2023A epoch 2025)", () => {
  const warn = vi.fn();
  const grid = createPopulationGrid({ directories: [DATA_DIRECTORY], logger: { warn } });

  it("loads the committed data file without warning", () => {
    expect(grid.isAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("classifies Antarctica interior, open ocean and the Sahara as red", () => {
    expect(grid.classify(-80, 0)).toBe("red");
    expect(grid.classify(-90, 45)).toBe("red");
    expect(grid.classify(0, -140)).toBe("red");
    expect(grid.classify(23, 12)).toBe("red");
  });

  it("classifies dense cities as urban", () => {
    expect(grid.classify(40.758, -73.985)).toBe("urban");
    expect(grid.classify(39.74, -104.99)).toBe("urban");
  });

  it("classifies remote Alaska villages as orange or rural", () => {
    expect(["orange", "rural"]).toContain(grid.classify(68.12, -145.53));
    expect(["orange", "rural"]).toContain(grid.classify(70.13, -143.62));
  });

  it("handles the antimeridian, poles and invalid input", () => {
    expect(grid.classify(-17.7, 179.99)).toBe(grid.classify(-17.7, -180.01));
    expect(grid.classify(90, 180)).toBe("red");
    expect(grid.classify(-90, -180)).toBe("red");
    expect(grid.classify(Number.NaN, 10)).toBe("urban");
  });

  it("finds the data file from the default search locations", () => {
    expect(defaultPopulationGridDirectories()).toContain(DATA_DIRECTORY);
  });
});

describe("population grid fallback", () => {
  it("falls back to urban with one warning when the file is missing", async () => {
    const warn = vi.fn();
    const grid = createPopulationGrid({ directories: [await tempDirectory()], logger: { warn } });
    expect(grid.classify(0, -140)).toBe("urban");
    expect(grid.classify(-80, 0)).toBe("urban");
    expect(grid.isAvailable()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to urban when the sha256 does not match the header", async () => {
    const directory = await tempDirectory();
    await copyFile(path.join(DATA_DIRECTORY, "population-grid-v1.json"), path.join(directory, "population-grid-v1.json"));
    await writeFile(path.join(directory, "population-grid-v1.bin.gz"), gzipSync(Buffer.alloc(7200 * 3600, 0)));
    const warn = vi.fn();
    const grid = createPopulationGrid({ directories: [directory], logger: { warn } });
    expect(grid.classify(40.758, -73.985)).toBe("urban");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0].err)).toContain("sha256");
  });

  it("falls back to urban when the file is not gzip", async () => {
    const directory = await tempDirectory();
    const header = {
      version: 1, cellDegrees: 0.05, cols: 7200, rows: 3600, rawBytes: 7200 * 3600,
      sha256: createHash("sha256").update("x").digest("hex")
    };
    await writeFile(path.join(directory, "population-grid-v1.json"), JSON.stringify(header));
    await writeFile(path.join(directory, "population-grid-v1.bin.gz"), Buffer.from("not gzip"));
    const warn = vi.fn();
    const grid = createPopulationGrid({ directories: [directory], logger: { warn } });
    expect(grid.classify(0, -140)).toBe("urban");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
