import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy gameplay feedback", () => {
  it("does not emit redundant combat and gathering lifecycle toasts", () => {
    const app = read("App.tsx");
    const combat = read("features/combatEquipment/useCombatEquipmentFrameHandler.ts");
    const harvesting = read("features/harvesting/useHarvestingFrameHandler.ts");

    expect(app).not.toContain("Moving into range for");
    expect(app).not.toContain("Starting ${activity}");
    expect(combat).not.toContain('showActionError("Combat started.")');
    expect(combat).not.toContain('showActionError("Combat stopped.")');
    expect(harvesting).not.toContain('showActionError("Collected resource.")');
    expect(harvesting).not.toContain('"CHOPPING started."');
    expect(harvesting).not.toContain('"MINING started."');
    expect(harvesting).not.toContain('"Resource Vision ready."');
  });

  it("does not emit a toast when selecting a world object", () => {
    const app = read("App.tsx");

    expect(app).not.toContain('showActionError("Ground loot selected.")');
    expect(app).not.toContain("pickedCollectible.type)} selected.");
    expect(app).not.toContain("pickedPlayer.username} selected.");
    expect(app).not.toContain("pickedCombatEntity.name} selected.");
    expect(app).not.toContain("pickedManor.ownerUsername}'s manor selected.");
  });

  it("uses a themed alert surface for actionable errors only", () => {
    const app = read("App.tsx");
    const styles = read("styles.css");
    const errorNoticeRule = styles.match(/\.action-error-notice,\s*\.action-success-notice\s*\{[^}]+\}/s)?.[0] ?? "";

    expect(app).toContain('className="action-error-notice" role="alert"');
    expect(errorNoticeRule).toContain("border: 1px solid var(--aa-ui-border)");
    expect(errorNoticeRule).toContain("background: var(--aa-ui-material-leather)");
    expect(errorNoticeRule).not.toContain("125, 211, 252");
    expect(errorNoticeRule).not.toContain("8, 47, 73");
  });
});

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}
