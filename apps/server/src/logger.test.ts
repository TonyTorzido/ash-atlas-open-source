import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger, requestPathForLog } from "./logger.js";

describe("authentication log redaction", () => {
  it("drops query strings before request URLs are logged", () => {
    expect(requestPathForLog("/ws?sessionToken=raw-session#fragment")).toBe("/ws");
  });

  it("redacts credentials, cookies, authorization, CSRF, and raw auth tokens", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const logger = createLogger("development", destination);

    logger.info({
      credential: "google-id-token",
      sessionToken: "session-token",
      deviceToken: "device-token",
      csrfToken: "csrf-token",
      email: "player@example.com",
      req: {
        headers: {
          authorization: "Bearer secret",
          cookie: "aa_session=secret",
          "x-csrf-token": "csrf-header"
        }
      }
    }, "redaction test");

    expect(output).not.toContain("google-id-token");
    expect(output).not.toContain("session-token");
    expect(output).not.toContain("device-token");
    expect(output).not.toContain("player@example.com");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("aa_session=secret");
    expect(output).not.toContain("csrf-header");
    expect(output).toContain("[REDACTED]");
  });
});
