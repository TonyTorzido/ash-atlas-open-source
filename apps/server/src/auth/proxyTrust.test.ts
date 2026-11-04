import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("reverse-proxy address trust", () => {
  it("ignores forwarding headers when no proxy is trusted", async () => {
    const app = await buildApp(false);
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" }
    });

    expect(response.json()).toEqual({ ip: "127.0.0.1" });
  });

  it("stops at the first untrusted hop instead of accepting a spoofed leftmost address", async () => {
    const config = loadConfig({ AUTH_TRUST_PROXY: "127.0.0.1,::1" });
    const app = await buildApp(config.AUTH_TRUST_PROXY);
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" }
    });

    expect(response.json()).toEqual({ ip: "203.0.113.9" });
  });
});

async function buildApp(trustProxy: false | string[]) {
  const app = Fastify({ trustProxy });
  apps.push(app);
  app.get("/ip", async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}
