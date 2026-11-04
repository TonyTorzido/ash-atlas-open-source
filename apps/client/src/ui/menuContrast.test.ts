import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../menuAppearance.css", import.meta.url), "utf8");
const luminance = (hex: string): number => {
  const channels = hex.match(/../g)!.map((pair) => parseInt(pair, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
};
it("keeps body, muted and accent text above 4.5:1 on every light paper state", () => {
  const light = css.slice(css.indexOf(":root"), css.indexOf('html[data-menu-theme="dark"]'));
  const token = (name: string): number => luminance(light.match(new RegExp(`--aa-menu-${name}: #([0-9a-f]{6})`))![1]!);
  for (const foreground of ["text", "muted", "accent"]) for (const background of ["page", "paper", "raised", "pressed"]) {
    expect((token(background) + .05) / (token(foreground) + .05), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});
