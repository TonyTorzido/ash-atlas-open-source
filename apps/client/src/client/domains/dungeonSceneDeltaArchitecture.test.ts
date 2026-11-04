import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
const gameClient = readFileSync(
  fileURLToPath(new URL("../../gameClient.ts", import.meta.url)),
  "utf8"
);

describe("dungeon scene delta wiring", () => {
  it("only gives GameApp materialized full snapshots", () => {
    expect(app).toContain("materializeDungeonSnapshot(frame.snapshot)");
    expect(app).toMatch(/materializeDungeonSnapshot\(frame\.snapshot\)[\s\S]*?if\s*\(snapshot\)\s*\{[\s\S]*?setDungeonSnapshot\(snapshot\);/);
  });

  it("clears immutable scene state on dungeon exit and client session reset", () => {
    expect(app).toContain("clientRef.current?.clearDungeonScene();");
    expect(gameClient).toContain("this.domains.dungeon.clearScene();");
  });
});
