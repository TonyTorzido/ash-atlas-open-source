import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { securityHeadersOptions } from "./securityHeaders.js";

describe("production security headers", () => {
  it("emits a narrow GIS-compatible CSP without paid-provider or eval sources", async () => {
    const app = Fastify();
    await app.register(helmet, securityHeadersOptions(loadConfig()));
    app.get("/", async () => ({ ok: true }));

    try {
      const response = await app.inject({ method: "GET", url: "/" });
      const csp = response.headers["content-security-policy"] ?? "";
      expect(csp).toContain(
        "script-src 'self' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com"
      );
      expect(csp).toContain("script-src-attr 'none'");
      expect(csp).toContain("frame-src https://accounts.google.com/gsi/");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("style-src-attr 'unsafe-inline'");
      expect(csp).toContain(
        "connect-src 'self' http://127.0.0.1:8765 https://accounts.google.com/gsi/ https://tile.openstreetmap.org https://cloudflareinsights.com"
      );
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toContain("recaptcha");
      expect(csp).not.toContain("www.google.com");
      expect(csp).not.toContain("www.gstatic.com");
      expect(response.headers["cross-origin-opener-policy"]).toBe(
        "same-origin-allow-popups"
      );
    } finally {
      await app.close();
    }
  });
});
