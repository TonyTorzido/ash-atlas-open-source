import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceFiles = [
  "App.tsx",
  "features/combatEquipment/useCombatEquipmentFrameHandler.ts",
  "features/developer/useDeveloperFrameHandler.ts",
  "features/flags/useFlagFrameHandler.ts",
  "features/harvesting/useHarvestingFrameHandler.ts",
  "features/manor/useManorFeature.ts",
  "features/session/useSessionFrameHandler.ts",
  "features/settlements/useSettlementFeature.ts",
  "features/travel/useTravelFrameHandler.ts"
] as const;

describe("global gameplay notice policy", () => {
  it("exposes only the centralized error-specific global notice API", () => {
    const combined = sourceFiles.map(read).join("\n");
    const app = read("App.tsx");

    expect(combined).not.toMatch(
      /\bshowToast\b|\bsetToastMessage\b|\bStatusToast\b|status-toast/
    );
    expect(app).toContain(
      "Global gameplay notices are error-only by default."
    );
    expect(app).toContain(
      "Do not add success or routine action notifications unless explicitly requested by product."
    );
    expect(app).toContain(
      'className="action-error-notice" role="alert"'
    );
  });

  it("does not pass the global error API into success-only feature handlers", () => {
    for (const path of [
      "features/flags/useFlagFrameHandler.ts",
      "features/harvesting/useHarvestingFrameHandler.ts"
    ]) {
      expect(read(path)).not.toContain("showActionError");
    }
    const developer = read("features/developer/useDeveloperFrameHandler.ts");
    const errorHandlerStart = developer.indexOf("export function handlePendingGoblinVillageSpawnError(");
    expect(errorHandlerStart).toBeGreaterThan(0);
    expect(developer.slice(0, errorHandlerStart)).not.toContain("showActionError");
    const errorHandler = developer.slice(errorHandlerStart, developer.indexOf("function grantFeedback("));
    expect(errorHandler).toContain("if (!message.requestId || requestRef.current !== message.requestId) return false;");
    expect(errorHandler).toContain("showActionError(message.message);");
  });

  it("keeps routine successes, cancellations, and transitions out of the global notice channel", () => {
    const combined = sourceFiles.map(read).join("\n");
    for (const message of [
      "Flag built.",
      "Queued flag build canceled",
      "Visited flag.",
      "Visited city center.",
      "Balsam Resin used.",
      "Stack moved.",
      "Your manor has been built at this location.",
      "Welcome home.",
      "Kingdom invitation sent.",
      "Class state updated.",
      "Equipment updated.",
      "Teleporting...",
      "Flags cleared."
    ]) {
      expect(combined).not.toContain(`showActionError("${message}`);
    }
  });

  it("preserves interaction sheets, timers, progress, and screen-reader announcements", () => {
    const app = read("App.tsx");

    expect(app).toContain("<CollectiblePrompt");
    expect(app).toContain("<MobileWorldActionSheet");
    expect(app).toContain("<MobileFlagActionSheet");
    expect(app).toContain("flagBuildRemainingTimeLabel(");
    expect(app).toContain("gatheringProgressForTask(");
    expect(app).toContain('role="progressbar"');
    expect(app).toContain("{harvestStatusAnnouncement}");
  });
});

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}
