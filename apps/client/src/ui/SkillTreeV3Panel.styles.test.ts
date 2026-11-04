import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./SkillTreeV3Panel.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./SkillTreeV3Panel.tsx", import.meta.url), "utf8");
const headerSource = readFileSync(new URL("./ProgressionDetailHeader.tsx", import.meta.url), "utf8");
const professionStyles = readFileSync(new URL("./ProfessionsDestination.css", import.meta.url), "utf8");
const professionSource = readFileSync(new URL("./ProfessionsDestination.tsx", import.meta.url), "utf8");
const theme = readFileSync(new URL("../ashAtlasTheme.css", import.meta.url), "utf8");

describe("SkillTreeV3Panel skill ledger styles", () => {
  it("defines one vertical scrolling ledger with a detail sheet", () => {
    expect(styles).toMatch(/\.skill-v3-ledger \{[^}]*overflow: hidden auto;/s);
    expect(styles).toMatch(/\.skill-v3-ledger \{[^}]*scrollbar-width: none;/s);
    expect(styles).toMatch(/\.skill-v3-discipline-list \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 300px\), 1fr\)\)/s);
    expect(styles).toMatch(/\.skill-v3-ledger-grid \{[^}]*repeat\(auto-fill, minmax\(min\(100%, 200px\), 1fr\)\)/s);
    expect(styles).toMatch(/\.skill-v3-ledger-cell \{[^}]*min-height: 56px/s);
    expect(styles).toContain('.skill-v3-ledger-cell[data-state="purchasable"] .skill-v3-ledger-icon');
    expect(styles).toContain("@container (min-width: 270px)");
    expect(styles).not.toContain("overflow-x: auto");
    expect(styles).toMatch(/\.skill-v3-app\[data-layout="phone"\] \.skill-v3-sheet \{[^}]*position: absolute;[^}]*bottom: 0;[^}]*max-height: 100%;/s);
    expect(styles).toMatch(/\.skill-v3-app\[data-layout="desktop"\] \.skill-v3-content\.has-sheet \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(300px, 38%\);/s);
    expect(styles).not.toContain("skill-v3-combat-detail");
    expect(styles).toMatch(/^\.skill-v3-shell \.phone-destination-body > \.skill-v3-app \{[^}]*flex: 1 1 0;/m);
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).not.toMatch(/cursor:\s*grab|transform-origin|progression-map-viewport|progression-map-canvas/);
  });

  it("keeps professions on their independent housed styling contract", () => {
    expect(professionStyles).toContain(".professions-list, .profession-detail-child");
    expect(professionStyles).toContain("scrollbar-width: thin");
    expect(professionStyles).toContain(".profession-detail-child");
    expect(professionStyles).not.toMatch(/professions[^\n{]*game-app-tabs|game-app-tabs[^\n{]*professions/);
  });

  it("uses the live skill ledger component instead of the old combat map", () => {
    expect(source).toContain("export function SkillLedger");
    expect(source).not.toContain("DisciplinePage");
    expect(source).not.toContain("DisciplineGrid");
    expect(source).toContain('GENERAL_SKILL_DEFINITIONS[id].category === "gateway"');
    expect(source).not.toContain("COMBAT_GATEWAY_IDS");
    expect(source).not.toContain("commits this build");
    expect(source).not.toContain("skill-v3-combat-detail-back");
    expect(source).not.toContain("ProgressionMap");
    expect(source).not.toContain("progression-map-viewport");
    expect(source).toContain("PhoneMenuFooterButtons");
    expect(source).not.toContain("footer={props.layout === \"desktop\" ? <GameAppActionBar>");
    expect(professionSource).not.toContain('variant="subtabs"');
    expect(professionSource).toContain("<ProgressionDetailSheet");
    expect(professionSource).toContain("data-profession-view=\"detail\"");
    expect(professionSource).toContain("PhoneMenuFooterButtons");
    expect(professionSource).not.toContain("profession-sheet");
    expect(professionStyles).toContain(".professions-entry-grid");
    expect(professionStyles).not.toContain("professions-entry-map");
  });

  it("keeps the progression root readable and the gateway action canonical", () => {
    expect(source).not.toContain("Choose a gateway to view its dependency family.");
    expect(source).toContain("definition.description");
    expect(source).toContain("definition.rankDefinitions.map");
    expect(headerSource).toContain("skill-v3-header-action");
    expect(styles).toContain(".skill-v3-shell .skill-v3-active-class-chip");
    expect(styles).toContain(".skill-v3-shell .game-app-body > .game-app-tabs-housed");
    expect(styles).toContain(".skill-v3-shell .phone-destination-body > .game-app-tabs-housed");
    expect(styles).toMatch(/\.skill-v3-shell \.game-app-body > \.game-app-tabs-housed[^}]*width: auto;[^}]*min-width: 0;[^}]*box-sizing: border-box;/s);
    expect(headerSource).toContain('className="skill-v3-summary"');
    expect(source).not.toContain("headerMeta");
    expect(styles).toContain(".skill-v3-summary-points");
    expect(styles).not.toContain("header-meta");
    expect(styles).not.toContain(".skill-v3-status");
  });

  it("shares the canonical phone footer buttons with desktop app footers", () => {
    const phoneSource = readFileSync(new URL("./PhoneMenuDestinationShell.tsx", import.meta.url), "utf8");
    expect(phoneSource).toContain("export function PhoneMenuFooterButtons");
    expect(phoneSource).toContain('<footer className="phone-menu-footer">');
    expect(theme).toMatch(/\.game-app-footer > \.phone-menu-back,[\s\S]*?\.game-app-footer > \.phone-menu-return\s*\{[^}]*min-height: 44px;[^}]*background: var\(--aa-ui-leather-800\);/s);
    expect(theme).not.toContain(".game-app-footer > .game-app-action-bar");
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-subtabs\s*\{[^}]*padding: 0;[^}]*border: 1px solid var\(--aa-ui-border-muted\);/s);
  });
});
