import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Advanced flag details mobile layout", () => {
  it("uses a bounded full-width phone drawer and wraps long IDs without horizontal overflow", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /html\[data-ui-profile="phone"\] \.advanced-flag-drawer\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*height:\s*100%/s
    );
    expect(css).toMatch(/\.advanced-field-value\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.advanced-raw-snapshot\s*\{[^}]*overflow:\s*auto/s);
  });
});
