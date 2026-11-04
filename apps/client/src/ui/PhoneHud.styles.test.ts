import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const theme = readFileSync(fileURLToPath(new URL("../ashAtlasTheme.css", import.meta.url)), "utf8");
const dock = readFileSync(fileURLToPath(new URL("../phoneBottomDock.css", import.meta.url)), "utf8");
const directMessageStyles = readFileSync(
  fileURLToPath(new URL("./DirectMessagesPanel.css", import.meta.url)),
  "utf8"
);
const indexHtml = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
const mainSource = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");
const presentationShell = readFileSync(
  fileURLToPath(new URL("../presentationShell.css", import.meta.url)),
  "utf8"
);
const nativeSceneDelegate = readFileSync(
  fileURLToPath(new URL("../../../../ios/App/App/SceneDelegate.swift", import.meta.url)),
  "utf8"
);
const phoneHudSource = readFileSync(fileURLToPath(new URL("./PhoneHud.tsx", import.meta.url)), "utf8");

describe("phone bottom HUD style contract", () => {
  it("anchors three compartments inside one full-height dock frame", () => {
    expect(dock).toMatch(/html\[data-ui-profile="phone"\] \.phone-bottom-bar\s*\{[^}]*right: 0;[^}]*bottom: 0;[^}]*left: 0;[^}]*width: 100%;/s);
    expect(dock).toMatch(/\.phone-bottom-bar\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--hud-menu-width\) minmax\(0, 1fr\)/s);
    expect(dock).toContain(".phone-bottom-status,");
    expect(dock).toContain(".phone-bottom-economy,");
    expect(dock).toContain(".phone-menu-trigger {");
    expect(dock).toMatch(/\.phone-bottom-bar\s*\{[^}]*background: var\(--aa-ui-leather-900\);[^}]*pointer-events: none;/s);
    expect(dock).toMatch(/\.phone-bottom-economy\s*\{[^}]*appearance: none;[^}]*cursor: pointer;[^}]*touch-action: manipulation;/s);
    expect(dock).toMatch(/\.phone-economy-row\s*\{[^}]*pointer-events: none;/s);
    expect(dock).toMatch(/\.phone-bottom-bar::before\s*\{[^}]*z-index: 0;[^}]*inset: 0;[^}]*background:/s);
    expect(dock).toMatch(/\.phone-bottom-bar::before\s*\{[^}]*background:[\s\S]*var\(--aa-ui-material-leather\);/s);
    expect(dock).not.toContain("var(--aa-ui-leather-900) 70%");
    expect(dock).toMatch(/\.phone-menu-trigger\s*\{[^}]*border: 1px solid var\(--aa-ui-bronze-500\);[^}]*border-radius: 4px 4px 7px 7px;/s);
    expect(dock).toMatch(/data-ui-profile="phone"\]\s*\{[^}]*--hud-bottom-content-height: 57\.6px;/s);
    expect(dock).toMatch(/orientation: landscape[\s\S]*?--hud-bottom-content-height: 50\.4px;/s);
    expect(dock).not.toContain(".phone-bottom-status::before");
    expect(dock).not.toContain(".phone-bottom-economy-compartment::before");
  });

  it("gives the footer sole ownership of a passive safe-area row and paints through it", () => {
    expect(styles).toContain("--hud-bottom-home-clearance: var(--hud-safe-bottom);");
    expect(styles).toContain("--hud-bottom-bar-height: calc(var(--hud-bottom-content-height) + var(--hud-bottom-home-clearance));");
    expect(dock).toContain("--hud-bottom-home-clearance: var(--hud-safe-bottom);");
    expect(dock).toMatch(/\.phone-bottom-bar\s*\{[^}]*grid-template-rows: var\(--hud-bottom-content-height\) var\(--hud-bottom-home-clearance\);/s);
    expect(dock).toMatch(/\.phone-bottom-status,[\s\S]*?\.phone-bottom-menu-compartment,[\s\S]*?\.phone-bottom-economy-compartment\s*\{[^}]*grid-row: 1 \/ -1;[^}]*pointer-events: none;/s);
    expect(dock).toMatch(/\.phone-bottom-economy\s*\{[^}]*height: var\(--hud-bottom-content-height\);/s);
    expect(dock).toMatch(/\.phone-bottom-bar::before\s*\{[^}]*inset: 0;[^}]*pointer-events: none;/s);
    expect(dock).toContain("padding: 0 var(--hud-safe-right) 0 var(--hud-safe-left);");
    expect(dock).not.toMatch(/\.phone-bottom-(?:status|economy)\s*\{[^}]*hud-safe-(?:left|right)/s);
    expect(dock).not.toMatch(/\.phone-bottom-(?:status|economy)(?!::after)[^{]*\{[^}]*hud-safe-bottom/s);
    expect(dock).not.toMatch(/\.phone-menu-trigger(?!::after)[^{]*\{[^}]*hud-safe-bottom/s);
    expect(styles).toMatch(/\.phone-menu-footer\s*\{[^}]*align-items: flex-end;[^}]*padding: 6px 10px max\(2px, calc\(var\(--hud-safe-bottom\) - 4px\)\)/s);
    expect(styles).not.toMatch(/data-display-mode="(?:browser|standalone)"[^}]*bottom:\s*[1-9]\d*px/s);
  });

  it("keeps the floating phone dock inside one viewport-bottom band", () => {
    expect(dock).not.toContain("--ios-dock-");
    expect(dock).toMatch(/html\[data-ui-profile="phone"\]:is\(\[data-presentation="touch"\], \[data-presentation="desktop"\]\)\s*\{[^}]*--hud-bottom-content-height: 108px;[^}]*--hud-bottom-home-clearance: var\(--hud-safe-bottom\);[^}]*--hud-bottom-bar-height: calc\(var\(--hud-bottom-content-height\) \+ var\(--hud-safe-bottom\)\);/s);
    expect(dock).toMatch(/html\[data-ui-profile="phone"\] \.phone-bottom-bar\s*\{[^}]*grid-template-rows: 32px 18px 50px;[^}]*overflow: visible;[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(dock).toContain("phone-bottom-bar-menu-hidden");
    expect(phoneHudSource).toContain("createPortal");
    expect(phoneHudSource).toMatch(/function ViewportHudPortal\([\s\S]*?stageBound[\s\S]*?document\.querySelector<HTMLElement>\("\.mobile-app-stage"\)/);
    expect(phoneHudSource).toMatch(/createPortal\(children, target\)/);
    expect(presentationShell).toMatch(/\.mobile-app-stage\s*\{[^}]*contain: size layout paint;/s);
  });

  it("keeps floating status and economy rows inside the safe-area dock shell", () => {
    expect(dock).not.toContain("--ios-dock-");
    expect(dock).toMatch(/html\[data-ui-profile="phone"\] \.phone-bottom-bar\s*\{[^}]*padding: 0 max\(8px, var\(--hud-safe-right\)\) calc\(8px \+ var\(--hud-safe-bottom\)\) max\(8px, var\(--hud-safe-left\)\);/s);
    expect(dock).toMatch(/html\[data-ui-profile="phone"\] \.phone-bottom-status,\s*html\[data-ui-profile="phone"\] \.phone-bottom-economy-compartment\s*\{[^}]*background: var\(--aa-ui-material-folio\);[^}]*border: 1px solid var\(--aa-ui-border\);/s);
    expect(dock).toContain("--hud-bottom-home-clearance: var(--hud-safe-bottom);");
  });

  it("keeps side ledgers open and bounds the raised center latch above the dock edge", () => {
    expect(dock).not.toContain(".phone-bottom-status::before");
    expect(dock).not.toContain(".phone-bottom-economy-compartment::before");
    expect(dock).toMatch(/\.phone-bottom-menu-compartment::before\s*\{[^}]*top: 8px;[^}]*right: 0;[^}]*bottom: calc\(var\(--hud-bottom-home-clearance\) \+ var\(--hud-menu-bottom-gap\)\);[^}]*left: 0;[^}]*border: 1px solid var\(--aa-ui-bronze-500\);[^}]*border-radius: 3px 3px 7px 7px;/s);
    expect(dock).not.toContain(".phone-bottom-status::after");
    expect(dock).not.toContain(".phone-bottom-economy::after");
    expect(dock).toMatch(/\.phone-menu-trigger\s*\{[^}]*height: calc\(var\(--hud-bottom-content-height\) - var\(--hud-menu-bottom-gap\)\);[^}]*margin: 0 0 var\(--hud-menu-bottom-gap\);[^}]*border-radius: 4px 4px 7px 7px;[^}]*border-bottom-color: var\(--aa-ui-bronze-500\);/s);
    expect(dock).toMatch(/\.phone-bottom-menu-compartment\.expanded::before\s*\{[^}]*background: var\(--aa-ui-wood-700\);/s);
  });

  it("places the compact combat controls in the safe-area lower-right grid", () => {
    expect(dock).toMatch(/\.legacy-controls-right\s*\{[^}]*right: max\(8px, var\(--hud-safe-right\)\);[^}]*bottom: calc\(var\(--hud-bottom-bar-height\) \+ 8px\);/s);
    expect(dock).toMatch(/\.legacy-controls-right\s*\{[^}]*grid-template-areas:\s*"status status"\s*"\. ultimate"\s*"\. skill-two"\s*"\. skill-one"\s*"taunt heal";/s);
    expect(dock).toMatch(/\.legacy-controls-right\s*\{[^}]*grid-template-columns: repeat\(2, 44px\);[^}]*grid-template-rows: auto repeat\(4, 44px\);[^}]*gap: 8px;[^}]*pointer-events: none;/s);
    expect(dock).toMatch(/\.legacy-control-button\s*\{[^}]*width: 44px;[^}]*height: 44px;[^}]*pointer-events: auto;/s);
    expect(dock).toMatch(/\.legacy-skill-button,[\s\S]*?\.legacy-taunt-button\s*\{[^}]*padding: 8px;/s);
    expect(dock).toMatch(/\.legacy-control-button svg\s*\{[^}]*width: 24px;[^}]*height: 24px;/s);
    // Heal lives in a quick slot; there is no floating heal button left to style.
    expect(dock).not.toContain(".legacy-heal-button");
  });

  it("keeps the utility hotbar compact and lets its rows reach just above the dock", () => {
    expect(styles).toMatch(/\.ash-hotbar\[hidden\]\s*\{\s*display:\s*none;\s*\}/s);
    expect(styles).toMatch(/\.ash-hotbar-slot\s*\{[\s\S]*?width: clamp\(72px, 8\.25vw, 99px\);[\s\S]*?min-height: 64px;/s);
    expect(styles).toMatch(/@media \(max-width: 700px\)\s*\{[\s\S]*?\.ash-hotbar-slot\s*\{[\s\S]*?width: min\(21vw, 81px\);[\s\S]*?min-height: 57px;/s);
    expect(styles).toMatch(/\/\* Quick-slot rows[\s\S]*?\.ash-hotbar-slot\s*\{[\s\S]*?width: clamp\(72px, 8\.25vw, 99px\);[\s\S]*?min-height: 64px;[\s\S]*?grid-template-columns: 34px minmax\(0, 1fr\);[\s\S]*?padding: 7px 22px 7px 8px;[\s\S]*?\.ash-hotbar-slot \.item-artwork,[\s\S]*?width: 32px; height: 32px;/s);
    expect(styles).toMatch(/\/\* Quick-slot rows[\s\S]*?@media \(max-width: 700px\)[\s\S]*?\.ash-hotbar-slot\s*\{[\s\S]*?width: min\(14vw, 54px\);[\s\S]*?min-height: 48px;[\s\S]*?\.ash-hotbar-slot \.item-artwork,[\s\S]*?width: 22px; height: 22px;[\s\S]*?\.ash-hotbar-copy strong \{ font-size: 10px; \}[\s\S]*?\.ash-hotbar-copy small \{ font-size: 9px; \}/s);
    expect(dock).toMatch(/\.ash-hotbar\s*\{[^}]*--ash-hotbar-bottom-lift: 0px;[^}]*bottom: calc\(var\(--hud-bottom-bar-height, 0px\) \+ 6px\);/s);
    expect(dock).toMatch(/\.legacy-control-button\.legacy-flag-button\s*\{[^}]*width: 48px;[^}]*height: 48px;/s);
    // Quick slots are shown/hidden by holding the dock's bag, not a floating toggle.
    expect(phoneHudSource).not.toContain('className="legacy-control-button legacy-hotbar-toggle"');
    expect(phoneHudSource).toContain("{...economyGesture}");
  });

  it("keeps Settings housed, single-scroll, and safe from native select autofocus", () => {
    expect(phoneHudSource).toMatch(/function MiscellaneousDestination\([\s\S]*?<GameAppShell[\s\S]*?layout="phone"[\s\S]*?initialFocus="container"/s);
    expect(styles).toMatch(/\.phone-miscellaneous-layer > \.phone-destination-body\s*\{[^}]*overflow: hidden auto;[^}]*padding:[^}]*var\(--hud-safe-right\)[^}]*var\(--hud-safe-bottom\)/s);
    expect(styles).toMatch(/\.phone-settings-app\s*\{[^}]*display: grid;[^}]*align-content: start;/s);
    expect(styles).toMatch(/\.phone-settings-app \.game-app-card > div\s*\{[^}]*display: grid;[^}]*gap: 10px;/s);
    expect(styles).toMatch(/\.ash-hotbar-layout-editor-scrim\s*\{[^}]*background: color-mix\(in srgb, var\(--aa-ui-ink-950\) 18%, transparent\)/s);
    expect(styles).toMatch(/\.ash-hotbar-layout-editor-panel\s*\{[^}]*bottom: max\(var\(--hud-safe-bottom, 0px\), 8px\);[^}]*width: auto;/s);
    expect(styles).toMatch(/\.ash-hotbar-layout-editor-panel > :is\([\s\S]*?h2, p\)\s*\{[^}]*clip-path: inset\(50%\)/s);
    expect(styles).toMatch(/\.ash-hotbar-layout-editor-actions \.game-app-button\s*\{[^}]*min-height: 36px;[^}]*font-size: 11px;/s);
  });

  it("keeps all eight rails inside the safe stage between chat and the bottom HUD", () => {
    expect(styles).toMatch(/\.ash-hotbar\s*\{[\s\S]*?position: fixed;[\s\S]*?inset-inline: 0;[\s\S]*?bottom: calc\(var\(--hud-bottom-bar-height, 0px\) \+ max\(var\(--hud-safe-bottom, 0px\), 8px\) \+ 10px \+ var\(--ash-hotbar-status-clearance\) \+ var\(--ash-hotbar-bottom-lift\)\);[\s\S]*?padding-inline: max\(var\(--hud-safe-left, 8px\), 8px\) max\(var\(--hud-safe-right, 8px\), 8px\);/s);
    expect(styles).toMatch(/@media \(max-width: 700px\)\s*\{[\s\S]*?\.ash-hotbar\s*\{[\s\S]*?--ash-hotbar-bottom-lift: var\(--hud-bottom-content-height, 57\.6px\);[\s\S]*?bottom: calc\(var\(--hud-bottom-bar-height, 0px\) \+ max\(var\(--hud-safe-bottom, 0px\), 8px\) \+ 8px \+ var\(--ash-hotbar-status-clearance\) \+ var\(--ash-hotbar-bottom-lift\)\);[\s\S]*?padding-inline: max\(var\(--hud-safe-left, 0px\), 5px\) max\(var\(--hud-safe-right, 0px\), 5px\);/s);
    expect(styles).toMatch(/\.ash-hotbar-rail\s*\{[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: 9px;/s);
    expect(styles).toMatch(/@media \(max-width: 700px\)[\s\S]*?\.ash-hotbar-rail\s*\{[^}]*gap: 7px;/s);
    expect(phoneHudSource).toMatch(/function ViewportHudPortal\([\s\S]*?stageBound[\s\S]*?document\.querySelector<HTMLElement>\("\.mobile-app-stage"\)/);
    expect(phoneHudSource).toMatch(/<ViewportHudPortal stageBound=\{effectiveLayoutMode === "wide"\}>/);
    expect(presentationShell).toMatch(/\.mobile-app-stage\s*\{[\s\S]*?contain: size layout paint;/s);
    expect(presentationShell).toMatch(/html\[data-layout-mode="wide"\] \.mobile-app-stage\s*\{[\s\S]*?width: var\(--desktop-mobile-stage-width\);[\s\S]*?height: var\(--desktop-mobile-stage-height\);/s);
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--hud-safe-top: var\(--sai-top, env\(safe-area-inset-top, 0px\)\);[\s\S]*?--hud-chat-height: 40px;[\s\S]*?--hud-bottom-bar-height: calc\(var\(--hud-bottom-content-height\) \+ var\(--hud-bottom-home-clearance\)\);/s);
  });

  it("layers the animated Rage perimeter above cooldowns without changing touch geometry", () => {
    expect(dock).toMatch(/\.legacy-resource-perimeter\s*\{[^}]*position: absolute;[^}]*z-index: 3;[^}]*inset: 0;[^}]*width: 44px;[^}]*height: 44px;[^}]*pointer-events: none;/s);
    expect(dock).toMatch(/\.legacy-cooldown-overlay\s*\{[^}]*z-index: 2;/s);
    expect(dock).toMatch(/\.legacy-resource-fill\s*\{[^}]*stroke: #c93831;[^}]*transition: stroke-dashoffset 150ms ease-out;/s);
    expect(dock).toMatch(/\.legacy-resource-perimeter\.ready \.legacy-resource-fill\s*\{[^}]*stroke: #f04a3f;/s);
    const disabledRule = dock.match(/\.legacy-control-button:disabled,[\s\S]*?\.legacy-control-button\[aria-disabled="true"\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(disabledRule).not.toMatch(/opacity|visibility|filter/);
  });

  it("styles explicit compact DOM without generated HUD labels or values", () => {
    expect(dock).toContain(".status-bar-compact-label");
    expect(dock).toContain(".status-bar-compact-value");
    expect(`${styles}\n${theme}\n${dock}`).not.toMatch(/\.status-bar-label (?:span|strong)::after/);
    expect(`${styles}\n${theme}\n${dock}`).not.toContain("data-phone-value");
  });

  it("uses one fixed icon column and full-width tracks for all three status rows", () => {
    expect(dock).toContain("--phone-status-label-width: 20px;");
    expect(dock).toContain("--phone-dock-resource-track-height: 12px;");
    expect(dock).toContain("--phone-dock-secondary-track-height: 10px;");
    expect(dock).toMatch(/\.status-bar-phone-dock\s*\{[^}]*grid-template-columns:\s*var\(--phone-status-label-width\)\s*minmax\(0, 1fr\);/s);
    expect(dock).not.toMatch(/\.status-bar-phone-dock\s*\{[^}]*var\(--phone-status-value-width\)/s);
    expect(dock).toMatch(/\.status-bar-compact-value\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*display: flex;[^}]*justify-content: center;[^}]*width: 100%;[^}]*font-variant-numeric: tabular-nums;[^}]*text-align: center;/s);
    expect(dock).toMatch(/\.status-bar-compact-maximum\s*\{[^}]*color: inherit;[^}]*font-weight: inherit;/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-compact-label\s*\{[^}]*justify-content: center;[^}]*gap: 0;/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-compact-icon\s*\{[^}]*width: 16px;[^}]*height: 16px;[^}]*vector-effect: non-scaling-stroke;/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-health \.status-bar-compact-icon\s*\{[^}]*width: 18px;[^}]*height: 18px;/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-experience \.status-bar-compact-icon\s*\{[^}]*transform: translateX\(2px\);/s);
    expect(dock).toMatch(/\.phone-economy-row-icon\s*\{[^}]*width: 14px;[^}]*height: 14px;[^}]*vector-effect: non-scaling-stroke;/s);
    expect(dock).toMatch(/\.phone-economy-storage \.phone-economy-row-icon\s*\{[^}]*color: var\(--aa-ui-text-bright\);/s);
    expect(dock).toMatch(/\.phone-economy-gold \.phone-economy-row-icon\s*\{[^}]*color: var\(--aa-ui-active-bronze\);/s);
    expect(dock).not.toMatch(/\.phone-economy-gold \.phone-economy-row-icon\s*\{[^}]*transform:/s);
    expect(dock).toMatch(/\.phone-economy-row\s*\{[^}]*grid-template-columns: var\(--phone-status-label-width\) minmax\(0, 1fr\);/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-health \.status-bar-compact-value\s*\{[^}]*color: var\(--aa-ui-text-bright\);[^}]*font-size: 12px;[^}]*font-weight: 800;/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-experience \.status-bar-compact-value\s*\{[^}]*color: var\(--aa-ui-text-bright\);[^}]*font-size: 10px;[^}]*font-weight: 500;/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-hunger \.status-bar-compact-value\s*\{[^}]*color: var\(--aa-ui-text-bright\);/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-experience \.status-bar-track\s*\{[^}]*height: var\(--phone-dock-secondary-track-height\);/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-hunger \.status-bar-track\s*\{[^}]*height: var\(--phone-dock-secondary-track-height\);/s);
    expect(dock).toMatch(/\.phone-bottom-status \.status-bar-health \.status-bar-track\s*\{[^}]*height: var\(--phone-dock-resource-track-height\);/s);
    expect(dock).not.toContain("text-overflow: ellipsis");
  });

  it("keeps the authoritative player state above Storage and Gold in the right ledger", () => {
    expect(dock).toMatch(/\.phone-bottom-economy\s*\{[^}]*grid-template-rows: repeat\(3, minmax\(0, 1fr\)\);/s);
    expect(dock).not.toContain(".phone-bottom-economy:hover");
    expect(dock).toContain(".phone-bottom-economy:active");
    expect(dock).toContain(".phone-bottom-economy:focus-visible");
    expect(dock).toContain(".phone-economy-state");
    expect(dock).toContain(".phone-economy-state-aggression");
    expect(dock).toContain(".phone-economy-state-protection");
    expect(dock).toContain(".phone-economy-state-none");
    expect(dock).not.toContain(".phone-economy-aggro");
    expect(dock).not.toContain(".phone-economy-protection");
    expect(dock).not.toContain(".phone-economy-storage:active");
    expect(dock).not.toContain(".status-bar-adornment .aggressive-timer");
  });

  it("keeps every state row bounded while protecting economy icon cells from dividers", () => {
    expect(dock).not.toContain(".phone-economy-row + .phone-economy-row::before");
    expect(dock).toMatch(/\.phone-economy-state\s*\{[^}]*grid-template-columns: var\(--phone-status-label-width\) var\(--phone-economy-value-width\) minmax\(0, 1fr\);[^}]*gap: 3px;/s);
    expect(dock).toMatch(/\.phone-economy-storage\s*\{[^}]*grid-template-columns: var\(--phone-status-label-width\) minmax\(0, 1fr\);[^}]*gap: 3px;/s);
    expect(dock).toMatch(/\.phone-economy-state-copy\s*\{[^}]*min-width: 0;[^}]*display: flex;[^}]*align-items: center;/s);
    expect(dock).toMatch(/\.phone-economy-state-track\s*\{[^}]*width: 100%;[^}]*height: 8px;[^}]*box-sizing: border-box;[^}]*border: 1px solid var\(--aa-ui-border-muted\);[^}]*background:[\s\S]*?var\(--aa-ui-ink-950\);/s);
    expect(dock).toMatch(/\.phone-economy-state-fill\s*\{[^}]*display: block;[^}]*width: 100%;[^}]*height: 100%;[^}]*transition: width 120ms linear;[^}]*background: currentColor;/s);
    expect(dock).toMatch(/\.phone-economy-state-protection\s*\{[^}]*color: var\(--aa-ui-active-bronze\);/s);
    expect(dock).not.toContain(".phone-economy-state-protection .phone-economy-state-track");
    expect(dock).toMatch(/\.phone-economy-state-none\s*\{[^}]*color: var\(--aa-ui-text-bright\);/s);
    expect(dock).toMatch(/\.phone-player-state-glyph\s*\{[^}]*width: 14px;[^}]*height: 14px;[^}]*vector-effect: non-scaling-stroke;/s);
    expect(dock).toMatch(/\.phone-economy-state-value\s*\{[^}]*grid-column: 2;[^}]*width: 100%;[^}]*font-variant-numeric: tabular-nums;[^}]*text-align: left;/s);
    expect(dock).toMatch(/\.phone-economy-state strong\s*\{[^}]*color: var\(--aa-ui-text-bright\);/s);
    expect(dock).toMatch(/\.phone-economy-state-none \.phone-economy-state-track\s*\{[^}]*border-color: transparent;[^}]*background: transparent;[^}]*box-shadow: none;[^}]*opacity: 0;/s);
    expect(dock).toMatch(/\.phone-economy-state-none \.phone-economy-state-value\s*\{[^}]*visibility: hidden;/s);
  });

  it("keeps ledger values inside their bars and gives only real capacity a quiet meter", () => {
    expect(dock).toContain("--phone-economy-value-width: clamp(52px, 18vw, 76px);");
    expect(dock).toMatch(/\.phone-economy-row strong\s*\{[^}]*text-align: left;/s);
    expect(dock).toMatch(/\.phone-economy-storage-track\s*\{[^}]*height: var\(--phone-dock-resource-track-height\);[^}]*background: var\(--aa-ui-leather-900\);[^}]*overflow: hidden;/s);
    expect(dock).toMatch(/\.phone-economy-storage-track\s*\{[^}]*position: relative;[^}]*grid-column: 2;[^}]*grid-row: 1;/s);
    expect(dock).toMatch(/\.phone-economy-storage-value\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*display: flex;[^}]*justify-content: center;[^}]*overflow: visible;[^}]*color: var\(--aa-ui-text-bright\);[^}]*font: 600 10px\/1 var\(--aa-ui-font-body\);[^}]*font-variant-numeric: tabular-nums;[^}]*text-align: center;/s);
    expect(dock).toMatch(/\.phone-economy-storage-fill\s*\{[^}]*background: var\(--aa-ui-bronze-500\);/s);
    expect(dock).toMatch(/\.inventory-full \.phone-economy-storage-fill\s*\{[^}]*background: var\(--aa-ui-danger\);/s);
    expect(dock).toMatch(/\.phone-economy-storage-track\[aria-hidden="true"\]\s*\{[^}]*visibility: hidden;/s);
    expect(dock).toMatch(/@media \(min-width: 720px\)[\s\S]*?\.phone-bottom-economy\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[^}]*grid-template-rows: minmax\(0, 1fr\);/s);
    expect(dock).toMatch(/\.phone-economy-row > strong\s*\{[^}]*grid-row: 2;[^}]*text-align: center;/s);
    expect(dock).toMatch(/\.phone-economy-storage::before\s*\{[^}]*border-left: 1px solid var\(--aa-ui-border-muted\);[^}]*pointer-events: none;/s);
  });

  it("uses one dynamic-viewport overlay with shallow three-column app grids", () => {
    expect(styles).toMatch(/\.phone-menu-layer\s*\{[^}]*height: var\(--app-viewport-height\);[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
    expect(styles).toMatch(/\.phone-hud\.phone-hud-menu-open\.phone-hud-menu-underlay\s*\{[^}]*z-index: var\(--hud-z\);/s);
    expect(styles).toMatch(/\.phone-menu-layer\.phone-menu-layer-underlay\s*\{[^}]*pointer-events: none;/s);
    expect(styles).toMatch(/\.phone-menu-group-panel\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(styles).toMatch(/\.phone-menu-root\s*\{[^}]*min-width: 0;[^}]*display: grid;[^}]*gap: 10px;/s);
    expect(styles).toMatch(/\.phone-menu-primary-grid,[\s\S]*?\.phone-menu-realm-grid\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s);
    expect(styles).toContain(".phone-menu-primary-grid {\n  grid-template-rows: repeat(3, minmax(76px, 1fr));\n  grid-auto-rows: minmax(76px, 1fr);\n}");
    expect(styles).toContain("grid-auto-rows: minmax(76px, 1fr);");
    expect(styles).toContain(".phone-menu-realm-grid {\n  grid-template-rows: minmax(68px, auto);");
    expect(styles).toContain(".phone-menu-group-panel .phone-menu-item:last-child:nth-child(odd)");
    expect(styles).toContain(".phone-menu-root-item {\n  grid-column: auto;");
    expect(theme).toMatch(/\.phone-menu-primary-grid \.phone-menu-root-item,[\s\S]*?\.phone-menu-realm-grid \.phone-menu-root-item\s*\{[^}]*background: var\(--aa-ui-material-leather\);[^}]*box-shadow: inset 0 1px var\(--aa-ui-highlight\);/s);
    expect(styles).toContain(".phone-menu-group-panel::before");
    expect(styles).toMatch(/\.phone-menu-label\s*\{[^}]*display: flex;/s);
    const badgeRule = styles.match(/\.phone-menu-item \.phone-menu-unread-badge\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(badgeRule).toContain("display: inline-flex;");
    expect(badgeRule).not.toMatch(/position\s*:/);
    expect(styles).not.toContain(".phone-menu-grid");
    expect(styles).toMatch(/\.phone-menu-footer\s*\{[^}]*var\(--hud-safe-bottom\)/s);
    expect(styles).toMatch(/\.phone-menu-back,[\s\S]*?\.phone-menu-signout\s*\{[^}]*min-height: 44px;/s);
    expect(styles).not.toContain(".phone-menu-drag");
    expect(styles).not.toContain(".phone-menu-preferences");
    expect(styles).not.toContain(".phone-destination-back");
  });

  it("keeps root utilities compact in the header and the footer as one full-width return action", () => {
    expect(styles).toMatch(/\.phone-menu-root-header\s*\{[^}]*flex-wrap: wrap;/s);
    expect(styles).toMatch(/\.phone-menu-header-actions\s*\{[^}]*display: flex;[^}]*align-items: center;/s);
    expect(styles).toMatch(/\.phone-menu-root-header \.phone-menu-header-action\s*\{[^}]*min-height: 44px;[^}]*padding: 6px;/s);
    expect(styles).toMatch(/\.phone-menu-root-footer\s*\{\s*display: block;/s);
    expect(styles).toMatch(/\.phone-menu-root-footer \.phone-menu-return\s*\{[^}]*width: 100%;[^}]*flex: 1 1 auto;/s);
    expect(styles).toMatch(/@media \(max-width: 380px\)[\s\S]*?\.phone-menu-root-header \.phone-menu-world-time\s*\{[^}]*max-width: 96px;/s);
    expect(theme).toMatch(/\.ui-standards-menu-preview \.phone-menu-footer\s*\{[^}]*display: block;/s);
  });

  it("keeps select-then-confirm prompts visible immediately above the footer", () => {
    expect(styles).toMatch(/\.mobile-world-action-sheet\s*\{[^}]*bottom: calc\(var\(--hud-bottom-bar-height\) \+ 18px\);/s);
    expect(styles).toMatch(/\.manor-scene \.mobile-world-action-sheet\s*\{[^}]*bottom: calc\(var\(--hud-bottom-bar-height\) \+ 8px\);/s);
    expect(theme).not.toMatch(/\.manor-floor\s*\{[^}]*filter:/s);
    expect(theme).toMatch(/\.manor-floor-art\s*\{[^}]*filter:/s);
    expect(styles).toMatch(/\.combat-target-prompt,[\s\S]*?\.flag-panel\s*\{[^}]*bottom: calc\(var\(--hud-bottom-bar-height\) \+ 8px\);/s);
    expect(styles).not.toMatch(/data-ui-profile="phone"[^}]*\.combat-target-prompt[^}]*display:\s*none/s);
  });

  it("keeps canonical fishing prompts out of the river and phone footer", () => {
    expect(styles).toMatch(/\.fishing-targeting-placement\s*\{[^}]*top: calc\(max\(var\(--hud-safe-top, 0px\), 8px\) \+ var\(--hud-chat-height, 40px\) \+ 8px\);[^}]*right: max\(8px, var\(--hud-safe-right, 0px\)\);/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.fishing-targeting-placement\s*\{[^}]*position: fixed;[^}]*top: calc\(var\(--hud-safe-top\) \+ var\(--hud-chat-height\) \+ 8px\);[^}]*right: max\(8px, var\(--hud-safe-right\)\);/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.fishing-targeting-placement\s*\{[^}]*max-height: calc\(100cqh - var\(--hud-safe-top\) - var\(--hud-chat-height\) - var\(--hud-bottom-bar-height\) - 16px\);/s);
    expect(styles).toMatch(/\.fishing-overworld-controls \.fishing-overworld-control \{[^}]*min-height: 44px;/s);
    expect(theme).toContain('@import "./ui/GameCompactUi.css";');
  });

  it("uses the bronze and parchment medieval palette and removes phone zoom chrome", () => {
    expect(styles).toContain("--hud-active-bronze: #98703d;");
    expect(styles).toContain("--hud-focus-parchment: #e7dcc2;");
    expect(styles).toContain('html[data-ui-profile="phone"] .maplibregl-ctrl-top-left { display: none; }');
    expect(styles).toMatch(/\.phone-menu-group-panel\s*\{[^}]*border: 1px solid var\(--aa-ui-border\);/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.class-panel\s*\{[^}]*background: #0d0b08;/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.world-map-overlay\s*\{[^}]*background: #0d0b08;/s);
    expect(styles).toMatch(/\.phone-map-settings input\[type="range"\]::-webkit-slider-thumb\s*\{[^}]*background: #c9a968;/s);
  });

  it("uses the installed iOS full viewport and locks page zoom while preserving map gestures", () => {
    expect(styles).toContain("--app-viewport-height: 100dvh;");
    expect(styles).toMatch(/@media \(display-mode: standalone\)\s*\{[\s\S]*?--app-viewport-height: 100vh;[\s\S]*?--app-viewport-height: 100lvh;/s);
    expect(styles).toMatch(/html\[data-display-mode="standalone"\]\s*\{[^}]*--app-viewport-height: 100vh;[^}]*--app-viewport-height: 100lvh;/s);
    expect(styles).toMatch(/html\[data-native-app="true"\]\s*\{[^}]*--app-viewport-height: 100vh;[^}]*--app-viewport-height: 100lvh;/s);
    expect(styles).toMatch(/html,\s*body\s*\{[^}]*height: var\(--app-viewport-height\);/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.chat-panel\s*\{[^}]*touch-action: pan-y;/s);
    expect(indexHtml).toMatch(/name="viewport" content="[^"]*width=device-width[^"]*viewport-fit=cover/);
    expect(indexHtml).toMatch(/name="viewport" content="[^"]*interactive-widget=resizes-content/);
    expect(indexHtml).toContain("maximum-scale=1");
    expect(indexHtml).toContain("user-scalable=no");
    expect(mainSource).toMatch(/document\.addEventListener\("gesturestart",\s*preventDocumentGestureZoom,\s*\{ passive: false \}\);/);
    expect(mainSource).toMatch(/document\.addEventListener\("gesturechange",\s*preventDocumentGestureZoom,\s*\{ passive: false \}\);/);
    expect(mainSource).toMatch(/document\.addEventListener\("wheel",\s*preventDocumentWheelZoom,\s*\{ passive: false \}\);/);
    expect(mainSource).toMatch(/initializeNativeViewportRootState\(\);/);
  });

  it("keeps the Capacitor root controller edge-to-edge while preserving safe-area content insets", () => {
    expect(nativeSceneDelegate).toMatch(/private final class AshAtlasBridgeViewController: CAPBridgeViewController/);
    expect(nativeSceneDelegate).toMatch(/edgesForExtendedLayout = \[\.top, \.bottom, \.left, \.right\]/);
    expect(nativeSceneDelegate).toMatch(/extendedLayoutIncludesOpaqueBars = true/);
    expect(nativeSceneDelegate).toMatch(/view\.insetsLayoutMarginsFromSafeArea = false/);
    expect(nativeSceneDelegate).toMatch(/webView\?\.scrollView\.contentInsetAdjustmentBehavior = \.never/);
    expect(nativeSceneDelegate).toMatch(/override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge\s*\{\s*\.bottom\s*\}/s);
    expect(nativeSceneDelegate).toMatch(/rootViewController = AshAtlasBridgeViewController\(\)/);
  });

  it("keeps opaque chat protection independent while docking only the composer region", () => {
    expect(styles).toMatch(/\.mobile-chat-protection\s*\{[^}]*position: fixed;[^}]*z-index: var\(--hud-chat-protection-z\);[^}]*inset: -100cqh 0;[^}]*background: #0d0b08;/s);
    expect(styles).toMatch(/\.mobile-chat-overlay\.mobile-chat-overlay\s*\{[^}]*position: fixed;[^}]*inset: 0;[^}]*width: 100%;[^}]*height: var\(--app-viewport-height\);[^}]*padding: 0;/s);
    expect(styles).toMatch(/\.mobile-chat-protection\[data-mobile-chat-presence="exiting"\]\s*\{[^}]*display: none;[^}]*pointer-events: none;/s);
    expect(styles).toMatch(/\.mobile-chat-overlay\[data-mobile-chat-presence="exiting"\]\s*\{[^}]*visibility: hidden;[^}]*pointer-events: none;/s);
    expect(styles).not.toContain("data-mobile-chat-gesture");
    expect(styles).not.toContain("mobile-chat-edge-swipe-zone");
    expect(styles).toMatch(/:root\s*\{[^}]*--mobile-chat-applied-keyboard-inset: 0px;/s);
    expect(presentationShell).not.toContain("--mobile-chat-keyboard-boundary");
    expect(styles).toMatch(/:root\s*\{[^}]*--mobile-chat-composer-bottom-padding: max\(9px, env\(safe-area-inset-bottom\)\);/s);
    expect(styles).toMatch(/:root\s*\{[^}]*--mobile-chat-standalone-focus-drop: 0px;/s);
    expect(styles).toMatch(/data-ios-standalone-chat-locked="true"\]\s*\{[^}]*position: fixed;[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%;[^}]*overflow: hidden;[^}]*overscroll-behavior: none;/s);
    expect(styles).toMatch(/data-ios-standalone-chat-locked="true"\],[\s\S]*?data-ios-standalone-chat-locked="true"\] #root\s*\{[^}]*background-color: #0d0b08;/s);
    expect(styles).toMatch(/data-ios-standalone-chat-locked="true"\]\[data-ui-profile="phone"\][^{]*\.mobile-chat-overlay\.mobile-chat-overlay\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%;/s);
    expect(styles).not.toContain('.mobile-chat-overlay[data-mobile-chat-type="direct"]');
    expect(styles).not.toMatch(/\.mobile-chat-overlay\.mobile-chat-overlay\s*\{[^}]*var\(--mobile-chat-(?:keyboard|committed-keyboard)-inset\)/s);
    expect(styles).not.toContain("--mobile-chat-viewport-top");
    expect(styles).not.toContain("--mobile-chat-viewport-height");
    expect(styles).toMatch(/\.phone-hud\[data-chat-suppressed="true"\]\s*\{[^}]*visibility: hidden;[^}]*pointer-events: none;/s);
    expect(styles).not.toMatch(/data-mobile-chat-protected="true"[\s\S]*?\.phone-hud\s*\{/s);
    expect(styles).toMatch(/data-mobile-chat-composer\]\s*\{[^}]*padding-bottom: var\(--mobile-chat-composer-bottom-padding\);/s);
    expect(styles).toMatch(/data-mobile-chat-composer\]\s*\{[^}]*transform: none;/s);
    expect(styles).toMatch(/data-mobile-chat-dock-layout\][^{]*\{[^}]*padding-bottom: var\(--mobile-chat-applied-keyboard-inset\);/s);
    expect(styles).toMatch(/data-mobile-keyboard-committed="true"\]\s*\{[^}]*--mobile-chat-composer-bottom-padding: 1px;[^}]*\}[\s\S]*?data-ios-standalone-chat-locked="true"\]\[data-text-entry-focused="true"\]\s*\{[^}]*--mobile-chat-composer-bottom-padding: 0px;/s);
    expect(styles).toMatch(/html\[data-ios-standalone-chat-locked="true"\]\[data-text-entry-focused="true"\]\[data-mobile-keyboard-committed="true"\]\s*\{[^}]*--mobile-chat-standalone-focus-drop: env\(safe-area-inset-bottom\);/s);
    expect(styles).not.toMatch(/data-mobile-keyboard-phase="opening"[\s\S]*?data-mobile-chat-composer/);
    expect(styles).not.toMatch(/\.chat-message-list\s*\{[^}]*--mobile-chat-applied-keyboard-inset/s);
    expect(styles).toMatch(/\.chat-message-list\s*\{[^}]*display: flex;[^}]*flex-direction: column;/s);
    expect(styles).toMatch(/\.chat-message-spacer\s*\{[^}]*flex: 1 0 0;/s);
    expect(directMessageStyles).not.toMatch(/\.direct-messages-panel--phone \.direct-message-history-content\s*\{[^}]*--mobile-chat-applied-keyboard-inset/s);
    expect(directMessageStyles).toMatch(/\.direct-message-new-messages\s*\{[^}]*bottom: calc\(70px \+ var\(--mobile-chat-applied-keyboard-inset\)\);/s);
    expect(styles).toMatch(/\.chat-composer label\s*\{[^}]*display: block;/s);
    expect(styles).toMatch(/data-ui-profile="phone"\] \.chat-composer\s*\{[^}]*padding:[^;}]*var\(--mobile-chat-composer-bottom-padding\)/s);
    expect(styles).toMatch(/\.chat-composer textarea\s*\{[^}]*display: block;/s);
    expect(styles).toMatch(/data-ui-profile="phone"\] \.chat-composer textarea\s*\{[^}]*font: inherit;[^}]*font-size: 16px;[^}]*line-height: 1.3;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer label\s*\{[^}]*display: block;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer\s*\{[^}]*padding: var\(--aa-ui-space-2\) 10px;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer textarea\s*\{[^}]*display: block;/s);
    expect(directMessageStyles).toMatch(/\.direct-messages-panel--phone \.direct-message-composer textarea\s*\{[^}]*font-size: 16px;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer:focus-within,[\s\S]*?label:focus-within\s*\{[^}]*outline: none;[^}]*box-shadow: none;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer textarea:focus,[\s\S]*?textarea:focus-visible\s*\{[^}]*border-color: var\(--dm-gold\);[^}]*outline: none;[^}]*box-shadow: none;/s);
    expect(styles).not.toContain("--app-visible-offset-top");
    expect(styles).not.toContain("--app-visible-height");
    expect(styles).not.toMatch(/body::after\s*\{[^}]*background:\s*#0d0b08/s);
    expect(directMessageStyles).not.toContain("--app-visible-offset-top");
    expect(directMessageStyles).not.toContain("--app-visible-height");
    expect(directMessageStyles).not.toContain('data-virtual-keyboard="open"');
  });

  it("removes the wide presentation grid only while public Atlas Chats is open", () => {
    expect(presentationShell).not.toContain(
      "radial-gradient(circle at 50% 45%, rgb(73 49 33 / 22%), transparent 58%)"
    );
    expect(presentationShell).toMatch(
      /html\[data-layout-mode="wide"\] \.app-presentation:has\(\s*#public-chat-panel\[data-mobile-chat-presence="open"\]\s*\)\s*\{[^}]*background-image: none;/s
    );
    expect(presentationShell).not.toContain(
      '.app-presentation:has(.direct-messages-panel--phone)'
    );
  });

  it("explicitly restores the authoritative public chat bar only in gameplay", () => {
    expect(styles).toMatch(/\.chat-top-bar\s*\{[^}]*height: 44px;[^}]*align-items: stretch;[^}]*gap: 0;[^}]*overflow: visible;[^}]*border-radius: 8px;/s);
    expect(styles).toMatch(/\.chat-channel-picker\s*\{[^}]*align-self: stretch;[^}]*height: 100%;[^}]*margin: 0;[^}]*padding: 0;[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(styles).toMatch(/\.chat-top-bar-room\s*\{[^}]*appearance: none;[^}]*width: 100%;[^}]*height: 100%;[^}]*border-radius: 8px 0 0 8px;[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(styles).toMatch(/\.chat-top-bar-messages\s*\{[^}]*appearance: none;[^}]*width: 52px;[^}]*height: 100%;[^}]*border-radius: 0 8px 8px 0;[^}]*background: transparent;[^}]*box-shadow: none;[^}]*transform: none;/s);
    expect(styles).toMatch(/data-ui-profile="phone"\] \.chat-top-bar\s*\{[^}]*grid-template-columns: 82px minmax\(0, 1fr\) 52px 52px;/s);
    expect(styles).toMatch(/data-ui-profile="phone"\] \.chat-top-bar-room\s*\{[^}]*height: 100%;[^}]*pointer-events: auto;/s);
    expect(styles).toMatch(/data-ui-profile="phone"\] \.chat-top-bar-open\s*\{[^}]*height: 100%;[^}]*pointer-events: auto;/s);
    expect(theme).toMatch(/\.chat-top-bar-room\s*\{[^}]*background: transparent;/s);
    expect(theme).toMatch(/\.chat-top-bar-messages\s*\{[^}]*background: transparent;[^}]*background-image: none;[^}]*box-shadow: none;/s);
    expect(styles).toContain('html[data-ui-profile="phone"] .chat-top-bar-utility { display: none; }');
    expect(styles).toMatch(/\.game-shell:not\(\[data-mobile-menu-view="gameplay"\]\) \.chat-top-bar,[\s\S]*?visibility: hidden;[^}]*pointer-events: none;/s);
    expect(styles).toMatch(/\.game-shell\[data-mobile-menu-view="gameplay"\] \.chat-top-bar\s*\{[^}]*display: grid;[^}]*visibility: visible;[^}]*opacity: 1;[^}]*pointer-events: auto;/s);
  });

  it("keeps action rails slim, touchable, and flush with the phone edges", () => {
    expect(styles).toContain("--hud-action-visible: 34px;");
    expect(styles).toContain("--hud-action-hit: 44px;");
    expect(styles).toContain("--hud-quick-slot-visible-height: 68px;");
    expect(styles).toContain("--hud-quick-slot-stack-height: calc((var(--hud-quick-slot-visible-height) * 4) + (var(--hud-rail-gap) * 3));");
    expect(styles).toContain("--hud-quick-slot-top: clamp(");
    expect(styles).toMatch(/\.phone-action-rail-left\s*\{[^}]*left: calc\(var\(--hud-safe-left\) - 5px\);/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail\s*\{[^}]*top: var\(--hud-quick-slot-top\);[^}]*grid-template-rows: var\(--hud-action-hit\) minmax\(0, auto\);[^}]*transform: none;/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail-left\s*\{[^}]*left: 0;/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail-right\s*\{[^}]*right: 0;/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail-left \.phone-quick-slot-toggle\s*\{[^}]*left: 0;/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail-right \.phone-quick-slot-toggle\s*\{[^}]*right: 0;/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail-left\.is-open \.phone-quick-slot-toggle\s*\{[^}]*transform: translateX\(var\(--hud-quick-slot-visible\)\);/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail-right\.is-open \.phone-quick-slot-toggle\s*\{[^}]*transform: translateX\(calc\(var\(--hud-quick-slot-visible\) \* -1\)\);/s);
    expect(styles).toMatch(/\.phone-quick-slot-stack\s*\{[^}]*height: 0;[^}]*max-height: 0;[^}]*transition: height 140ms ease-out, max-height 140ms ease-out, opacity 100ms ease-out;/s);
    expect(styles).toMatch(/\.phone-quick-slot-rail\.is-open \.phone-quick-slot-stack\s*\{[^}]*height: var\(--hud-quick-slot-stack-height\);[^}]*max-height: var\(--hud-quick-slot-stack-height\);[^}]*pointer-events: auto;/s);
    expect(styles).not.toMatch(/\.phone-quick-slot-rail\.is-open \.phone-quick-slot-stack\s*\{[^}]*padding-block:/s);
    expect(styles).toMatch(/\.phone-quick-slot\s*\{[^}]*height: var\(--hud-quick-slot-visible-height\);[^}]*min-height: var\(--hud-action-hit\);/s);
    expect(styles).toMatch(/\.phone-quick-slot > svg\s*\{[^}]*top: 50%;[^}]*transform: translateY\(-50%\);/s);
    expect(styles).toMatch(/\.phone-quick-slot-toggle::before\s*\{[^}]*background:[\s\S]*var\(--aa-ui-leather-700\)/s);
    expect(styles).toMatch(/\.phone-quick-slot::before\s*\{[^}]*width: var\(--hud-quick-slot-visible\);[^}]*height: var\(--hud-quick-slot-visible-height\);[^}]*background:[\s\S]*var\(--aa-ui-leather-800\)/s);
    expect(styles).toMatch(/\.warrior-quick-slot,[\s\S]*?\.universal-taunt-button\s*\{[^}]*width: 36px;[^}]*height: 44px;/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.combat-kit-hotbar\s*\{[^}]*top: calc\(var\(--hud-safe-top\) \+ var\(--hud-chat-height\) \+ 58px\);[^}]*grid-template-columns: repeat\(6, minmax\(44px, 1fr\)\);/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.combat-kit-button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/s);
  });
});

describe("touch bottom dock tray", () => {
  const touch = dock.replace(/\r\n/g, "\n");
  it("runs phones edge to edge with no gap beneath the footer", () => {
    expect(touch).toMatch(/html\[data-ui-profile="phone"\]\[data-presentation="touch"\] \{[^}]*--dock-inset-x: 0px;[^}]*--dock-tray-bottom: 0px;[^}]*--dock-radius-bottom: 0px;/s);
    expect(touch).toMatch(/\.phone-bottom-bar::before \{[^}]*inset: 0 var\(--dock-inset-x\) var\(--dock-tray-bottom\);[^}]*border-radius: var\(--dock-radius-top\) var\(--dock-radius-top\) var\(--dock-radius-bottom\) var\(--dock-radius-bottom\);/s);
  });
  it("curves the tray's lower corners into the screen on iOS", () => {
    expect(touch).toMatch(/:is\(\[data-native-platform="ios"\], \[data-ios-standalone="true"\]\) \{[^}]*--dock-inset-x: 0px;[^}]*--dock-tray-bottom: 0px;[^}]*--dock-radius-bottom: var\(--aa-ios-display-radius, 50px\);/s);
    expect(touch).toContain("@supports (-webkit-touch-callout: none)");
  });
  it("floats a bounded tray only on wider touch screens", () => {
    expect(touch).toMatch(/@media \(min-width: 701px\) \{[^@]*--dock-max-width: 680px;[^@]*--dock-inset-x: 10px;/s);
  });
  it("raises a circular Menu medallion above the tray", () => {
    expect(touch).toMatch(/\.phone-bottom-menu-compartment \.phone-menu-trigger \{[^}]*margin-top: calc\(var\(--dock-medallion-rise\) \* -1\);[^}]*border-radius: 50%;/s);
  });
});
