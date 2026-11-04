import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("front gameplay HUD exposure", () => {
  it("mounts V3 actions on desktop with a legacy pre-snapshot fallback", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const app = readFileSync(`${directory}/../App.tsx`, "utf8");
    expect(app).not.toContain("<CombatKitHotbar");
    expect(app).toContain("<ClassQuickSlots");
    expect(app).toContain("<SkillSystemV3CombatControls");
    expect(app).toContain("skillSystemV3Snapshot ? (");
    expect(readFileSync(`${directory}/CombatKitHotbar.tsx`, "utf8")).toContain("export function CombatKitHotbar");
    expect(readFileSync(`${directory}/ClassQuickSlots.tsx`, "utf8")).toContain("ClassQuickSlots");
    expect(readFileSync(`${directory}/WarriorQuickSlots.tsx`, "utf8")).toContain("function ClassQuickSlots");
  });

  it("keeps the Party combat HUD available for a one-player party", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const app = readFileSync(`${directory}/../App.tsx`, "utf8");
    expect(app).toContain("hidden={!party || partyOverlayHidden}");
    expect(app).not.toContain("party.memberPlayerIds.length < 2");
  });
});
