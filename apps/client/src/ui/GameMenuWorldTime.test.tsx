import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GameMenuWorldTime } from "./PhoneHud.js";

describe("Game Menu world time", () => {
  it("renders synchronized game time without seconds and its phase", () => {
    const html = renderToStaticMarkup(<GameMenuWorldTime synchronizedNow={() => Date.parse("2026-01-01T07:00:00.000Z")} />);
    expect(html).toContain("6:00 AM");
    expect(html).toContain("Day");
    expect(html).toContain('aria-label="6:00 AM, Day"');
    expect(html).not.toContain("6:00:00");
  });
});
