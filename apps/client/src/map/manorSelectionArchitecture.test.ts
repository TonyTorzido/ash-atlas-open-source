import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("manor world-selection flow", () => {
  it("opens the information panel from the marker without entering immediately", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const markerBranch = app.slice(app.indexOf("if (pickedManor)"), app.indexOf("const picked = pickedCity"));
    expect(markerBranch).toContain("setSelectedManorId(pickedManor.manorId)");
    expect(markerBranch).toContain("setManorPanelOpen(true)");
    expect(markerBranch).not.toContain("requestEnterManor");
    expect(markerBranch).not.toContain("enterManor(");
  });

  it("keeps entry behind owner, active-party, or manor-invite eligibility and removes the old global toggle", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain("const selectedManorOwner = selectedManor?.ownerPlayerId === playerId");
    expect(app).toContain("const selectedManorPartyAccess = Boolean(");
    expect(app).toContain("const selectedManorInviteAccess = Boolean(");
    expect(app).toContain("selectedManorOwner || selectedManorPartyAccess || selectedManorInviteAccess");
    expect(app).not.toContain("onToggleManor");
  });

  it("clears the manor prompt on empty-map or other-entity selection", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const clickHandler = app.slice(app.indexOf("const pickedManor"), app.indexOf('map.on("zoom"'));
    expect(clickHandler).toContain("if (!pickedManor)");
    expect(clickHandler).toContain("setSelectedManorId(null)");
    expect(clickHandler).toContain("setManorPanelOpen(false)");
  });

  it("uses a harvesting-style nonmodal prompt with no scrim or focus trap", () => {
    const prompt = readFileSync(fileURLToPath(new URL("../ui/ManorPrompt.tsx", import.meta.url)), "utf8");
    expect(prompt).toContain('className="interaction-prompt manor-prompt"');
    expect(prompt).not.toContain("modal-scrim");
    expect(prompt).not.toContain("aria-modal");
    expect(prompt).not.toContain("useModalBehavior");
  });
});
