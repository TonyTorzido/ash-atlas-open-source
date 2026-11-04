import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entrySource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("Pixi strict CSP initialization", () => {
  it("installs the static Pixi shader synchronizers before the application loads", () => {
    const adapterImport = entrySource.indexOf('import "pixi.js/unsafe-eval";');
    const appImport = entrySource.indexOf('import { App } from "./App.js";');

    expect(adapterImport).toBeGreaterThanOrEqual(0);
    expect(appImport).toBeGreaterThan(adapterImport);
  });
});
