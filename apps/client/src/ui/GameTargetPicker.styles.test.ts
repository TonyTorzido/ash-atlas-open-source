import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compactUi = readFileSync(new URL("./GameCompactUi.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../ashAtlasTheme.css", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("GameTargetPicker layout contract", () => {
  it("keeps the rows as the only scrolling region and pins the action footer", () => {
    expect(compactUi).toMatch(/\.game-target-picker\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;[^}]*overflow: hidden;/s);
    expect(compactUi).toMatch(/\.game-target-list\s*\{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*scrollbar-width: thin;[^}]*touch-action: pan-y;/s);
    expect(compactUi).toMatch(/\.game-target-picker > \.game-compact-actions\s*\{[^}]*position: relative;[^}]*z-index: 1;/s);
    expect(theme).toMatch(/\.game-target-list::-webkit-scrollbar\s*\{[^}]*width: 8px;[^}]*height: 8px;/s);
    expect(theme).toMatch(/\.game-target-list::-webkit-scrollbar-thumb\s*\{[^}]*border: 2px solid var\(--aa-ui-ink-950\);[^}]*border-radius: 999px;[^}]*background: var\(--aa-ui-bronze-700\);/s);
  });

  it("caps phone pickers at three visible item rows plus Take All and Cancel", () => {
    expect(appStyles).toMatch(/html\[data-ui-profile="phone"\] \.mobile-world-target-picker\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;[^}]*max-height: min\([\s\S]*?calc\(5 \* var\(--game-target-row-height\) \+ 84px\)/s);
    expect(appStyles).toMatch(/html\[data-ui-profile="phone"\] \.mobile-world-target-list\s*\{[^}]*max-height: calc\(3 \* var\(--game-target-row-height\) \+ 2 \* var\(--game-target-row-gap\)\);[^}]*overflow-y: auto;[^}]*touch-action: pan-y;/s);
  });
});
