import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const themeStyles = readFileSync(new URL("../ashAtlasTheme.css", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const menuStyles = readFileSync(new URL("../menuAppearance.css", import.meta.url), "utf8");

describe("GameActionPrompt primary quick-action layout", () => {
  it("keeps a three-to-one action split and a full-width Cancel row on desktop and phone", () => {
    expect(themeStyles).toContain(".game-compact-actions--primary-quick");
    expect(themeStyles).toContain("grid-template-columns: minmax(0, 3fr) minmax(0, 1fr)");
    expect(themeStyles).toContain(".game-compact-actions--primary-quick .game-compact-cancel");
    expect(appStyles).toContain("html[data-ui-profile=\"phone\"] .mobile-world-action-buttons.game-compact-actions--primary-quick");
    expect(appStyles).toContain("grid-template-columns: minmax(0, 3fr) minmax(76px, 1fr)");
    expect(appStyles).toContain(".mobile-world-action-cancel");
  });

  it("keeps military movement actions as equal touch-friendly columns", () => {
    expect(themeStyles).toContain("[data-action-key=\"move-to-me\"]");
    expect(themeStyles).toContain("[data-action-key=\"follow\"]");
    expect(themeStyles).toContain("[data-action-key=\"stay\"]");
    expect(themeStyles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(themeStyles).toContain(".game-compact-actions--military-main-merge");
    expect(themeStyles).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(themeStyles).toContain("[data-action-key=\"merge\"]");
    expect(appStyles).toContain("html[data-ui-profile=\"phone\"] .mobile-world-action-buttons.game-compact-actions--military-main-merge");
  });
});

describe("GameActionPrompt focus ring", () => {
  it("never outlines the whole prompt container; only its buttons show focus-visible", () => {
    expect(appStyles).toContain("[tabindex]:focus-visible");
    expect(menuStyles).toContain("html .game-compact-prompt.game-action-prompt[tabindex]:focus-visible { outline: none; }");
    expect(menuStyles).toContain("html .game-compact-prompt.game-compact-prompt button:focus-visible { outline:");
  });
});
