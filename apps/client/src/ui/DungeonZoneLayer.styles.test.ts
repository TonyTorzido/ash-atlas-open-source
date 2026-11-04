import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./DungeonScene.css", import.meta.url)), "utf8");

describe("dungeon zoom layout", () => {
  it("keeps the fixed-center room surrounded by black clipped void", () => {
    expect(styles).toMatch(/\.dungeon-zone\s*\{[^}]*background: #000;/s);
    expect(styles).toMatch(/\.dungeon-stage-shell\s*\{[^}]*overflow: clip;[^}]*background: #000;/s);
    expect(styles).toMatch(/\.dungeon-stage-frame\s*\{[^}]*position: absolute;[^}]*inset: var\(--dungeon-fit-padding, 0px\);/s);
  });

  it("owns touch gestures without adding a separate dungeon control strip", () => {
    expect(styles).toMatch(/\.dungeon-stage-shell\s*\{[^}]*touch-action: none;/s);
    expect(styles).not.toContain(".dungeon-zoom-controls");
    expect(styles).not.toContain(".dungeon-header");
    expect(styles).not.toContain(".dungeon-status");
  });

  it("uses all Studio-authored environment color variables", () => {
    for (const variable of [
      "--dungeon-background-color",
      "--dungeon-floor-color",
      "--dungeon-wall-color",
      "--dungeon-accent-color"
    ]) {
      expect(styles).toContain(`var(${variable}`);
    }
  });

  it("smooths authoritative dungeon mobs and respects reduced motion", () => {
    expect(styles).toMatch(/\.dungeon-enemy\s*\{[^}]*transition: left 120ms linear, top 120ms linear;/s);
    expect(styles).toMatch(/@keyframes dungeon-enemy-attack-action\s*\{[\s\S]*?0%, 100%\s*\{[^}]*transform: translate\(0, 0\) rotate\(0deg\);[\s\S]*?30%, 40%\s*\{[^}]*calc\(var\(--dungeon-attack-direction-x, 0\) \* 6px[^}]*calc\(var\(--dungeon-attack-direction-y, -1\) \* 6px[^}]*rotate\(0deg\)/s);
    expect(styles).toMatch(/\.dungeon-enemy-pose-attack_action\s*\{[^}]*animation: dungeon-enemy-attack-action 450ms cubic-bezier\(\.333333, 0, \.666667, 1\);/s);
    expect(styles).toMatch(/prefers-reduced-motion: reduce[^}]*\.dungeon-enemy,\s*\.dungeon-enemy-target\s*\{ transition: none;/s);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dungeon-enemy-pose-attack_action\s*\{ animation: none; \}/s);
  });
});
