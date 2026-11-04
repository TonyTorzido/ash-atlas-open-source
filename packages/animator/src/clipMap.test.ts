import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allGameClipIds, CLIP_MAP, clipMapSchema, gameClipsFor } from "./clipMap.js";

// The client's sheet manifest, read only (the game client is not changed by the editor work).
const CLIENT_SHEETS = new URL("../../../apps/client/src/assets/player-rig/stock-body/stock-body-sheets.json", import.meta.url);
const CLIENT_ARMOUR = new URL("../../../apps/client/src/players/stockArmour.ts", import.meta.url);

describe("clipMap.json (PL-03)", () => {
  const sheets = JSON.parse(readFileSync(CLIENT_SHEETS, "utf8")) as { fps: number; clips: Record<string, { clip: string; flip: boolean; frames: unknown[] }> };

  it("every game clip of the client is mapped from an editor clip or listed as game-only", () => {
    expect(allGameClipIds()).toEqual(Object.keys(sheets.clips).sort());
  });

  it("rows match the client's sheets: source clip, flip, held frames and fps", () => {
    expect(CLIP_MAP.fps).toBe(sheets.fps);
    for (const [editor, row] of Object.entries(CLIP_MAP.clips)) {
      for (const g of row.game) {
        const sheet = sheets.clips[g.id]!;
        expect(sheet, `${editor} -> ${g.id}`).toBeDefined();
        expect(sheet.clip).toBe(row.source);
        expect(sheet.flip).toBe(g.flip);
        expect(sheet.frames.length).toBe(g.frames);
      }
    }
  });

  it("game ids are the client's StockClipId names", () => {
    const src = readFileSync(CLIENT_ARMOUR, "utf8");
    const union = /export type StockClipId =([^;]+);/.exec(src)?.[1] ?? "";
    for (const id of allGameClipIds()) {
      const base = id.replace(/[LR]$/, "");
      expect(union.includes(`"${id}"`) || union.includes(`"${base}"`), id).toBe(true);
    }
  });

  it("refuses a game clip mapped twice", () => {
    const bad = structuredClone(CLIP_MAP) as unknown as { clips: Record<string, { game: unknown[] }> };
    bad.clips["walk_down"]!.game.push({ id: "idle", side: "front", flip: false, frames: 1 });
    expect(() => clipMapSchema.parse(bad)).toThrow(/mapped twice/);
  });

  it("an unmapped editor clip feeds nothing", () => {
    expect(gameClipsFor("atk_sword_1")).toEqual([]);
    expect(gameClipsFor("gather_chop").map((g) => g.id)).toEqual(["chopL", "chopR"]);
  });
});
