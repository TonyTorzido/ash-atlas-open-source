import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

describe("simplified Warrior responsive UI contract", () => {
  it("uses a centered bounded class overlay with internal scrolling", () => {
    expect(styles).toContain(".class-panel-backdrop");
    expect(styles).toContain("place-items: center");
    expect(styles).toContain("width: min(1000px, 94cqw)");
    expect(styles).toContain("height: min(90cqh");
    expect(styles).toContain("max-height: min(90cqh");
    expect(styles).toContain(".class-panel-content { flex: 1 1 auto");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toContain("touch-action: pan-y");
    expect(styles).toContain(".progression-panel-content { scrollbar-gutter: stable; scrollbar-width: thin;");
    expect(styles).not.toMatch(/\.class-panel\s*\{[^}]*right:/s);
  });

  it("keeps eleven section tabs horizontally contained and touch-scrollable", () => {
    expect(styles).toMatch(/\.class-tabs\s*\{[^}]*overflow-x: auto/s);
    expect(styles).toMatch(/\.class-tabs\s*\{[^}]*touch-action: pan-x/s);
    expect(styles).toMatch(/\.class-tabs button\s*\{[^}]*white-space: nowrap/s);
    expect(styles).not.toContain("word-break: break-all");
  });

  it("places one empower and one technique control in paired columns with Taunt spanning both", () => {
    expect(styles).toMatch(/\.warrior-combat-controls\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(styles).toContain(".warrior-reset-slots, .warrior-normal-slots");
    expect(styles).toContain(".warrior-reset-slots { padding-right: 4px");
    expect(styles).toContain(".warrior-normal-slots { padding-left: 4px");
    expect(styles).toContain(".warrior-combat-controls > .universal-taunt-button { grid-column: 1 / -1; }");
  });

  it("uses wide paired ability cards and stacks each category cleanly on phone", () => {
    expect(styles).toMatch(/\.warrior-overview-grid, \.warrior-ability-pair \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(styles).toContain(".warrior-ability-group");
    expect(styles).toContain(".warrior-taunt-section");
    expect(styles).toMatch(/\.warrior-overview-grid, \.warrior-ability-pair, \.mastery-effect-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it("provides touch-sized quick actions and no hover-only combat affordance", () => {
    expect(styles).toMatch(/\.warrior-quick-slot\s*\{[^}]*min-height: 64px/s);
    expect(styles).toMatch(/\.warrior-quick-slot\s*\{[^}]*touch-action: manipulation/s);
    expect(styles).toMatch(/\.universal-taunt-button\s*\{[^}]*min-height: 58px/s);
    expect(styles).toMatch(/\.universal-taunt-button\s*\{[^}]*touch-action: manipulation/s);
    expect(styles).not.toMatch(/\.warrior-quick-slot:hover|\.universal-taunt-button:hover/);
  });

  it("keeps requirements, level milestones, and development controls readable", () => {
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(240px, 1fr))");
    expect(styles).toContain(".warrior-level-list li { display: grid");
    expect(styles).toContain(".dev-subclass-control");
    expect(styles).toContain(".class-loadout-summary");
    expect(styles).toContain(".technique-requirements, .dev-progression-controls, .dev-retained-class-catalog { grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps four class choices compact and targeting guidance inside the combat grid", () => {
    expect(styles).toMatch(/\.class-selector\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(styles).toContain(".warrior-combat-controls > .class-targeting-note { grid-column: 1 / -1; }");
    expect(styles).toContain(".class-targeting-note");
    expect(styles).not.toContain(".class-target-controls");
    expect(styles).not.toContain(".class-party-controls");
  });

  it("uses a phone breakpoint that preserves safe-area modal and compact combat controls", () => {
    expect(styles).toContain("@container mobile-app (max-width: 640px)");
    expect(styles).toContain("width: calc(100cqw - 16px)");
    expect(styles).toContain("width: min(178px, calc(100cqw - 20px))");
    expect(styles).toContain(".warrior-quick-slot { min-height: 58px; padding: 6px; }");
    expect(styles).toContain(".dev-subclass-control { grid-template-columns: minmax(70px, 1fr) auto; }");
  });
});
