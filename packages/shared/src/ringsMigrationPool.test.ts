import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RING_LOW_ELIGIBLE_BONUS_IDS, RING_QUARRY_FAMILIES } from "./rings.js";

/** Migration 1070 carries hand-written copies of these pools; they must match the shared data. */
describe("1070 stock-ring conversion pools", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../../db/migrations/1070_random_rings.sql", import.meta.url)),
    "utf8"
  );
  const arrayBefore = (alias: string): string[] => {
    const match = new RegExp(String.raw`ARRAY\[([^\]]*)\]::text\[\] AS ${alias}`, "u").exec(sql);
    if (!match) throw new Error(`1070 has no ${alias} array`);
    return [...match[1]!.matchAll(/'([^']+)'/gu)].map((entry) => entry[1]!);
  };

  it("converts with exactly the Low-eligible bonus pool", () => {
    expect(arrayBefore("bonus_ids")).toEqual([...RING_LOW_ELIGIBLE_BONUS_IDS]);
  });

  it("picks Quarry families from the shared family list", () => {
    expect(arrayBefore("families")).toEqual([...RING_QUARRY_FAMILIES]);
  });
});
